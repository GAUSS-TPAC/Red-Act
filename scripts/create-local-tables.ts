// Crée les tables du §9 dans DynamoDB Local (npm run local:db d'abord).
// Idempotent : une table existante est laissée telle quelle.
import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { REGION, TABLES, toCreateTableInput } from "@editeur/shared";

const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(endpoint)) {
  throw new Error(`Ce script ne vise que DynamoDB Local, pas ${endpoint}`);
}

// DynamoDB Local accepte n'importe quels identifiants : valeurs factices.
const client = new DynamoDBClient({
  endpoint,
  region: REGION,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

async function main() {
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
      console.log(`créée : ${def.tableName}`);
    } catch (error) {
      if (error instanceof ResourceInUseException) console.log(`existe déjà : ${def.tableName}`);
      else throw error;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
