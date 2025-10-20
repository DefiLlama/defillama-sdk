import { ENV_CONSTANTS } from "./env";
import { fetchJson } from "./common";

const { S3Client, PutObjectCommand, GetObjectCommand, } = require("@aws-sdk/client-s3");
const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = ENV_CONSTANTS

const datasetBucket = "defillama-datasets";
const publicBucketUrl = "https://defillama-datasets.llama.fi";

let R2: any;

if (R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
  R2 = new S3Client({
    region: "auto",
    endpoint: "https://" + R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

const getKey = (filename: string) => filename.replace(/(:|'|#)/g, '/')

export async function storeR2JSONString(filename: string, body: string | Buffer) {
  if (typeof body !== 'string') body = body.toString('base64')
  if (!R2) return;
  const command = new PutObjectCommand({
    Bucket: datasetBucket,
    Key: getKey(filename),
    Body: body,
    ContentType: "application/json",
  });
  return R2.send(command)
}

export async function getR2JSONString(filename: string) {
  try {

    if (!R2) return await _fetchData()
    const command = new GetObjectCommand({ Bucket: datasetBucket, Key: getKey(filename), });
    const { Body } = await R2.send(command);
    return await Body.transformToString()
  } catch (e) {
    return {}
  }

  async function _fetchData() {
    return fetchJson(`${publicBucketUrl}/${filename}`)
  }
}
