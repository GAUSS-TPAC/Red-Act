// Lecture du texte d'un PDF de test (pdfkit, compress: false).

/** Texte d'un PDF non compressé de pdfkit (polices standard : chaînes hexadécimales WinAnsi). */
export function pdfText(pdf: Uint8Array): string {
  const source = Buffer.from(pdf).toString("latin1");
  return [...source.matchAll(/<([0-9a-f]+)>/gi)].map((m) => Buffer.from(m[1]!, "hex").toString("latin1")).join("");
}
