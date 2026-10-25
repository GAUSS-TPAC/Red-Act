// Création idempotente des tables du §9 dans DynamoDB Local (script et tests).
import {
  CreateTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  ResourceInUseException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { REGION, TABLES, toCreateTableInput } from "@editeur/shared";

export const LOCAL_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";

export function localClient(endpoint = LOCAL_ENDPOINT) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(endpoint)) {
    throw new Error(`Réservé à DynamoDB Local, pas ${endpoint}`);
  }
  // DynamoDB Local accepte n'importe quels identifiants : valeurs factices.
  return new DynamoDBClient({
    endpoint,
    region: REGION,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
}

/** Trois essais : sous la charge d'une suite de tests, une JVM occupée peut tarder à répondre. */
export async function isLocalDbUp(client = localClient()): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await client.send(new ListTablesCommand({ Limit: 1 }), { abortSignal: AbortSignal.timeout(5000) });
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  console.warn(`DynamoDB Local injoignable (${LOCAL_ENDPOINT}), tests dépendants ignorés : ${String(lastError)}`);
  return false;
}

export async function ensureLocalTables(client = localClient(), log: (msg: string) => void = () => {}) {
  for (const def of Object.values(TABLES)) {
    try {
      await client.send(new CreateTableCommand(toCreateTableInput(def)));
      await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: def.tableName });
      if ("ttlAttribute" in def) {
        await client.send(
          new UpdateTimeToLiveCommand({
            TableName: def.tableName,
            TimeToLiveSpecification: { AttributeName: def.ttlAttribute, Enabled: true },
          }),
        );
      }
      log(`créée : ${def.tableName}`);
    } catch (error) {
      if (error instanceof ResourceInUseException) log(`existe déjà : ${def.tableName}`);
      else throw error;
    }
  }
}
