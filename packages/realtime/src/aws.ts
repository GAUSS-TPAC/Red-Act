/**
 * Clients AWS du serveur temps réel. Sur AWS, les identifiants viennent du rôle de
 * l'instance ; en local (DYNAMODB_ENDPOINT défini), des valeurs factices suffisent.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { REGION } from "@editeur/shared";
import type { BlobStore } from "./store.ts";

const region = () => process.env.AWS_REGION ?? REGION;

export function createDocumentClient(endpoint = process.env.DYNAMODB_ENDPOINT) {
  const client = new DynamoDBClient({
    region: region(),
    ...(endpoint ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}),
  });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

export function s3BlobStore(bucket: string): BlobStore {
  const s3 = new S3Client({ region: region() });
  return {
    async put(key, body) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/octet-stream" }));
    },
    async get(key) {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return result.Body!.transformToByteArray();
    },
  };
}

export async function readSecureParameter(name: string): Promise<string> {
  const ssm = new SSMClient({ region: region() });
  const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = result.Parameter?.Value;
  if (!value) throw new Error(`Paramètre SSM vide : ${name}`);
  return value;
}
