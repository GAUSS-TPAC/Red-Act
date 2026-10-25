import { describe, expect, it } from "vitest";
import { creditKey, isValidEmail, normalizeEmail, TABLES, toCreateTableInput, utcDay } from "../src/index.ts";

describe("identité", () => {
  it("normalise l'e-mail : minuscules, sans espaces", () => {
    expect(normalizeEmail("  Alan.T @Exemple.ORG \t")).toBe("alan.t@exemple.org");
  });

  it("valide grossièrement une adresse", () => {
    expect(isValidEmail("a@b.fr")).toBe(true);
    expect(isValidEmail("pas-une-adresse")).toBe(false);
  });

  it("change de clé de crédit à minuit UTC", () => {
    expect(utcDay(new Date("2026-10-25T23:59:59Z"))).toBe("2026-10-25");
    expect(creditKey("a@b.fr", new Date("2026-10-26T00:00:00Z"))).toBe("a@b.fr#2026-10-26");
  });
});

describe("schéma des tables", () => {
  it("définit les 8 tables du §9 avec des noms uniques", () => {
    const names = Object.values(TABLES).map((t) => t.tableName);
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(8);
  });

  it("produit une entrée CreateTable à la demande, clé de tri et index compris", () => {
    expect(toCreateTableInput(TABLES.journal)).toEqual({
      TableName: "editeur-journal",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "docId", KeyType: "HASH" },
        { AttributeName: "seq", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "docId", AttributeType: "S" },
        { AttributeName: "seq", AttributeType: "N" },
      ],
    });

    const links = toCreateTableInput(TABLES.links);
    expect(links.GlobalSecondaryIndexes?.[0]?.IndexName).toBe("liens-actifs");
    expect(links.AttributeDefinitions).toHaveLength(2);
  });
});
