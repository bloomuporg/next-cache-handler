import { NEXT_CACHE_IMPLICIT_TAG_ID, NEXT_CACHE_TAGS_HEADER } from 'next/dist/lib/constants'
import { ListObjectsV2CommandOutput, S3 } from '@aws-sdk/client-s3'
import { getAWSCredentials, type CacheEntry, type CacheStrategy } from '@dbbs/next-cache-handler-common'

const TAGS_SEPARATOR = ','
const NOT_FOUND_ERROR = ['NotFound', 'NoSuchKey']

export class S3Cache implements CacheStrategy {
  public readonly client: S3
  public readonly bucketName: string

  constructor(bucketName: string) {
    const region = process.env.AWS_REGION
    const profile = process.env.AWS_PROFILE
    this.client = new S3({ region })

    getAWSCredentials({ region, profile }).then((credentials) => {
      this.client.config.credentials = credentials as unknown as S3['config']['credentials']
    })
    this.bucketName = bucketName
  }

  async get(pageKey: string, cacheKey: string): Promise<CacheEntry | null> {
    if (!this.client) return null

    const pageData = await this.client
      .getObject({
        Bucket: this.bucketName,
        Key: `${pageKey}/${cacheKey}.json`
      })
      .catch((error) => {
        if (NOT_FOUND_ERROR.includes(error.name)) return null
        throw error
      })

    if (!pageData?.Body) return null

    return JSON.parse(await pageData.Body.transformToString('utf-8'))
  }

  async set(pageKey: string, cacheKey: string, data: CacheEntry): Promise<void> {
    const input = {
      Bucket: this.bucketName,
      Key: `${pageKey}/${cacheKey}`,
      ...(data.tags?.length ? { Metadata: { tags: data.tags.join(TAGS_SEPARATOR) } } : {})
    }

    if (data.value?.kind === 'PAGE') {
      await this.client.putObject({ ...input, Key: `${input.Key}.html`, Body: data.value.html })
    }

    await this.client.putObject({ ...input, Key: `${input.Key}.json`, Body: JSON.stringify(data) })
  }

  async revalidateTag(tag: string): Promise<void> {
    // Revalidate by Path
    if (tag.startsWith(NEXT_CACHE_IMPLICIT_TAG_ID)) {
      await this.deleteAllByKeyMatch(tag.slice(NEXT_CACHE_IMPLICIT_TAG_ID.length))
      return
    }

    // Revalidate by Tag
    let nextContinuationToken: string | undefined = undefined
    do {
      const { Contents: contents = [], NextContinuationToken: token }: ListObjectsV2CommandOutput =
        await this.client.listObjectsV2({
          Bucket: this.bucketName,
          ContinuationToken: nextContinuationToken
        })
      nextContinuationToken = token

      for (const { Key: key } of contents) {
        if (!key) continue

        const args = { Bucket: this.bucketName, Key: key }
        const { Metadata: metadata = {}, Body: body } = await this.client.getObject(args)

        const { tags = '' } = metadata
        if (!!tags && tags.split(TAGS_SEPARATOR).includes(tag)) {
          const lastSlashIndex = key.lastIndexOf('/')
          await this.delete(
            key.substring(0, lastSlashIndex),
            key.substring(lastSlashIndex + 1).replace(/\.json$|\.html$/, '')
          )
          continue
        }

        if (key.endsWith('.json') && body) {
          const { value }: CacheEntry = JSON.parse(await body.transformToString('utf-8'))
          if (value?.kind === 'PAGE' && value.headers?.[NEXT_CACHE_TAGS_HEADER]?.toString()?.split(',').includes(tag)) {
            const lastSlashIndex = key.lastIndexOf('/')
            await this.delete(
              key.substring(0, lastSlashIndex),
              key.substring(lastSlashIndex + 1).replace(/\.json$|\.html$/, '')
            )
          }
        }
      }
    } while (nextContinuationToken)
    return
  }

  async delete(pageKey: string, cacheKey: string): Promise<void> {
    await this.client.deleteObject({ Bucket: this.bucketName, Key: `${pageKey}/${cacheKey}.json` }).catch((error) => {
      if (NOT_FOUND_ERROR.includes(error.name)) return null
      throw error
    })
    await this.client.deleteObject({ Bucket: this.bucketName, Key: `${pageKey}/${cacheKey}.html` }).catch((error) => {
      if (NOT_FOUND_ERROR.includes(error.name)) return null
      throw error
    })
  }

  async deleteAllByKeyMatch(pageKey: string): Promise<void> {
    let nextContinuationToken: string | undefined = undefined
    do {
      const { Contents: contents = [], NextContinuationToken: token }: ListObjectsV2CommandOutput =
        await this.client.listObjectsV2({
          Bucket: this.bucketName,
          ContinuationToken: nextContinuationToken,
          Prefix: `${pageKey}/`,
          Delimiter: '/'
        })
      nextContinuationToken = token

      for (const { Key: key } of contents) {
        if (!key) continue
        if (key.endsWith('.json') || key.endsWith('.html')) {
          await this.client.deleteObject({ Bucket: this.bucketName, Key: key })
        }
      }
    } while (nextContinuationToken)
    return
  }
}
