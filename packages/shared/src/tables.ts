/**
 * Schéma DynamoDB (CLAUDE.md §9) : source unique, utilisée par le script
 * de création locale et par la stack CDK.
 */

export type AttributeType = "S" | "N" | "B";

export interface KeyDef {
  name: string;
  type: AttributeType;
}

export interface IndexDef {
  indexName: string;
  partitionKey: KeyDef;
  sortKey?: KeyDef;
}

export interface TableDef {
  /** Nom physique de la table (identique en local et sur AWS). */
  tableName: string;
  partitionKey: KeyDef;
  sortKey?: KeyDef;
  /** Attribut TTL (secondes epoch), s'il y en a un. */
  ttlAttribute?: string;
  globalIndexes?: IndexDef[];
}

export const TABLES = {
  documents: {
    tableName: "editeur-documents",
    partitionKey: { name: "docId", type: "S" },
  },
  journal: {
    tableName: "editeur-journal",
    partitionKey: { name: "docId", type: "S" },
    sortKey: { name: "seq", type: "N" },
    ttlAttribute: "ttl",
  },
  credits: {
    tableName: "editeur-credits",
    partitionKey: { name: "pk", type: "S" },
    ttlAttribute: "ttl",
  },
  links: {
    tableName: "editeur-links",
    partitionKey: { name: "linkId", type: "S" },
    // Index creux : seuls les liens actifs portent `activeFlag`.
    globalIndexes: [
      {
        indexName: "liens-actifs",
        partitionKey: { name: "activeFlag", type: "S" },
        sortKey: { name: "linkId", type: "S" },
      },
    ],
  },
  reservations: {
    tableName: "editeur-reservations",
    partitionKey: { name: "reservationId", type: "S" },
    ttlAttribute: "ttl",
  },
  blocks: {
    tableName: "editeur-blocks",
    partitionKey: { name: "subject", type: "S" },
    ttlAttribute: "ttl",
  },
  presence: {
    tableName: "editeur-presence",
    partitionKey: { name: "docId", type: "S" },
    ttlAttribute: "ttl",
  },
  versions: {
    tableName: "editeur-versions",
    partitionKey: { name: "docId", type: "S" },
    sortKey: { name: "createdAt", type: "N" },
  },
} as const satisfies Record<string, TableDef>;

export type TableKey = keyof typeof TABLES;

export const TABLE_KEYS = Object.keys(TABLES) as TableKey[];

/** Valeur unique de `activeFlag` pour l'index creux des liens actifs. */
export const ACTIVE_FLAG = "1";

/**
 * Entrée de CreateTable (forme du SDK v3, sans en dépendre) en mode à la demande.
 */
export function toCreateTableInput(def: TableDef) {
  const attributes = new Map<string, AttributeType>();
  const keySchema = (pk: KeyDef, sk?: KeyDef) => {
    attributes.set(pk.name, pk.type);
    const schema: { AttributeName: string; KeyType: "HASH" | "RANGE" }[] = [
      { AttributeName: pk.name, KeyType: "HASH" },
    ];
    if (sk) {
      attributes.set(sk.name, sk.type);
      schema.push({ AttributeName: sk.name, KeyType: "RANGE" });
    }
    return schema;
  };

  const KeySchema = keySchema(def.partitionKey, def.sortKey);
  const GlobalSecondaryIndexes = def.globalIndexes?.map((index) => ({
    IndexName: index.indexName,
    KeySchema: keySchema(index.partitionKey, index.sortKey),
    Projection: { ProjectionType: "ALL" as const },
  }));

  return {
    TableName: def.tableName,
    BillingMode: "PAY_PER_REQUEST" as const,
    KeySchema,
    AttributeDefinitions: [...attributes].map(([AttributeName, AttributeType]) => ({
      AttributeName,
      AttributeType,
    })),
    ...(GlobalSecondaryIndexes ? { GlobalSecondaryIndexes } : {}),
  };
}
