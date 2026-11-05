import { ENV_CONSTANTS } from "./env";
import { fetchJson } from "./common";

const { S3Client, PutObjectCommand, GetObjectCommand, } = require("@aws-sdk/client-s3");
const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_CONFIG } = ENV_CONSTANTS

const datasetBucket = "defillama-datasets";
const privateDatasetBucket = "defillama-datasets-private";
const publicBucketUrl = "https://defillama-datasets.llama.fi";

type R2BucketConfig = {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  bucket?: string
}

// single env option for both buckets, example:
// R2_CONFIG='{"public":{"endpoint":"<id>.r2.cloudflarestorage.com","accessKeyId":"...","secretAccessKey":"...","bucket":"defillama-datasets"},"private":{"endpoint":"...","accessKeyId":"...","secretAccessKey":"...","bucket":"defillama-datasets-private"}}'
// falls back to R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY for the public bucket
type R2Config = {
  public?: R2BucketConfig
  private?: R2BucketConfig
}

function parseR2Config(): R2Config {
  let config: R2Config = {}
  if (typeof R2_CONFIG === 'string' && R2_CONFIG.trim().length) {
    try {
      config = JSON.parse(R2_CONFIG)
    } catch (e) {
      throw new Error('R2_CONFIG is not valid JSON')
    }
  }
  if (!config.public && R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
    config.public = { endpoint: R2_ENDPOINT as string, accessKeyId: R2_ACCESS_KEY_ID as string, secretAccessKey: R2_SECRET_ACCESS_KEY as string }
  }
  return config
}

const r2Config = parseR2Config()

function createClient(config?: R2BucketConfig) {
  if (!config || !config.endpoint || !config.accessKeyId || !config.secretAccessKey) return undefined
  return new S3Client({
    region: "auto",
    endpoint: "https://" + config.endpoint.replace(/^https?:\/\//, ''),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

const R2: any = createClient(r2Config.public)
const R2Private: any = createClient(r2Config.private)

const publicBucket = r2Config.public?.bucket ?? datasetBucket
const privateBucket = r2Config.private?.bucket ?? privateDatasetBucket

function getClient(isPrivate: boolean) {
  return isPrivate ? { client: R2Private, bucket: privateBucket } : { client: R2, bucket: publicBucket }
}

const getKey = (filename: string) => filename.replace(/(:|'|#)/g, '/')

export type R2Options = {
  private?: boolean // if true, use the private bucket (needs private config in R2_CONFIG)
}

export async function storeR2JSONString(filename: string, body: string | Buffer, { private: isPrivate = false }: R2Options = {}) {
  if (typeof body !== 'string') body = body.toString('base64')
  const { client, bucket } = getClient(isPrivate)
  if (!client) return;
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: getKey(filename),
    Body: body,
    ContentType: "application/json",
  });
  return client.send(command)
}

export async function getR2JSONString(filename: string, { throwErrorOnFail = false, private: isPrivate = false }: { throwErrorOnFail?: boolean } & R2Options = {}) {
  try {

    const { client, bucket } = getClient(isPrivate)
    if (!client) {
      if (isPrivate) throw new Error('Private R2 bucket is not configured, set R2_CONFIG.private')
      return await _fetchData()
    }
    const command = new GetObjectCommand({ Bucket: bucket, Key: getKey(filename), });
    const { Body } = await client.send(command);
    return await Body.transformToString()

  } catch (e) {

    if (throwErrorOnFail) throw e

    return {}
  }

  async function _fetchData() {
    return fetchJson(`${publicBucketUrl}/${filename}`)
  }
}
