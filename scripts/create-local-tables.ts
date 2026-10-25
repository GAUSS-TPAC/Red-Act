// Crée les tables du §9 dans DynamoDB Local (npm run local:db d'abord).
// Idempotent : une table existante est laissée telle quelle.
import { ensureLocalTables } from "./local-tables.ts";

ensureLocalTables(undefined, console.log).catch((error) => {
  console.error(error);
  process.exit(1);
});
