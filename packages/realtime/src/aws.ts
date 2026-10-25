/**
 * Clients AWS du serveur temps réel. Sur AWS, les identifiants viennent du rôle de
 * l'instance ; en local (DYNAMODB_ENDPOINT défini), des valeurs factices suffisent.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DeleteMessageBatchCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { REGION, type PdfRequest } from "@editeur/shared";
import type { PdfQueue } from "./pdf/consumer.ts";
import type { BlobStore } from "./store.ts";

const region = () => process.env.AWS_REGION ?? REGION;

export function createDocumentClient(endpoint = process.env.DYNAMODB_ENDPOINT) {
  const client = new DynamoDBClient({
    region: region(),
    ...(endpoint ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}),
    // Plafond par défaut du SDK : 50 connexions simultanées (voir l'API).
    requestHandler: { httpsAgent: { maxSockets: 512, keepAlive: true }, httpAgent: { maxSockets: 512, keepAlive: true } },
  });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

export function s3BlobStore(bucket: string): BlobStore {
  const s3 = new S3Client({ region: region() });
  return {
    async put(key, body, contentType = "application/octet-stream") {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
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

/** File SQS `pdf-requests` : long polling de 20 s, 10 messages au plus par lecture. */
export function sqsPdfQueue(queueUrl: string): PdfQueue {
  const sqs = new SQSClient({ region: region() });
  return {
    async receive() {
      const result = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20 }),
      );
      return (result.Messages ?? []).map((m) => ({
        handle: m.ReceiptHandle!,
        request: JSON.parse(m.Body!) as PdfRequest,
      }));
    },
    async remove(handles) {
      for (let i = 0; i < handles.length; i += 10) {
        await sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: handles.slice(i, i + 10).map((handle, k) => ({ Id: String(k), ReceiptHandle: handle })),
          }),
        );
      }
    },
  };
}
