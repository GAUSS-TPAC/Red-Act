/**
 * Clients AWS. Sur AWS, les identifiants viennent du rôle de l'instance ; en local
 * (DYNAMODB_ENDPOINT défini), des valeurs factices suffisent à DynamoDB Local.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PDF_URL_TTL_SECONDS, REGION } from "@editeur/shared";

const LOCAL_CREDENTIALS = { accessKeyId: "local", secretAccessKey: "local" };

export function createDocumentClient(endpoint = process.env.DYNAMODB_ENDPOINT) {
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? REGION,
    ...(endpoint ? { endpoint, credentials: LOCAL_CREDENTIALS } : {}),
  });
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export function createPresigner(bucket: string, local = Boolean(process.env.DYNAMODB_ENDPOINT)) {
  const s3 = new S3Client({
    region: process.env.AWS_REGION ?? REGION,
    ...(local ? { credentials: LOCAL_CREDENTIALS } : {}),
  });
  return (key: string) =>
    getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: 'attachment; filename="journal.pdf"',
        ResponseContentType: "application/pdf",
      }),
      { expiresIn: PDF_URL_TTL_SECONDS },
    );
}

export async function readSecureParameter(name: string): Promise<string> {
  const ssm = new SSMClient({ region: process.env.AWS_REGION ?? REGION });
  const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = result.Parameter?.Value;
  if (!value) throw new Error(`Paramètre SSM vide : ${name}`);
  return value;
}
