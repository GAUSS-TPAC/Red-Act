// Vérification C1 côté base : stock restant et nombre de réservations du lien.
import { GetCommand, ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TABLES } from "@editeur/shared";

export async function dbState(db: DynamoDBDocumentClient, linkId: string) {
  const link = (
    await db.send(new GetCommand({ TableName: TABLES.links.tableName, Key: { linkId }, ConsistentRead: true }))
  ).Item;

  let reservations = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new ScanCommand({
        TableName: TABLES.reservations.tableName,
        FilterExpression: "linkId = :l",
        ExpressionAttributeValues: { ":l": linkId },
        Select: "COUNT",
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    reservations += page.Count ?? 0;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return {
    remaining: link?.remaining as number,
    status: link?.status as string,
    activeFlag: (link?.activeFlag as string | undefined) ?? null,
    reservations,
  };
}
