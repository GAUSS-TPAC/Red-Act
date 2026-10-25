/**
 * Demandes de PDF envoyées au serveur temps réel par la file SQS `pdf-requests`.
 *
 * Pendant un pic (C5), des milliers de clics « 202 » et leurs rappels demanderaient
 * le même PDF : chaque instance ne renvoie une demande pour un document que si elle
 * porte une séquence plus grande, ou si la précédente date de plus de 5 s (perte
 * éventuelle). Le serveur temps réel fusionne de toute façon les demandes.
 */
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { REGION, type PdfRequest } from "@editeur/shared";

export const RESEND_AFTER_MS = 5_000;

export function dampedPdfRequester(send: (request: PdfRequest) => Promise<void>, now: () => number = Date.now) {
  const last = new Map<string, { seqRequis: number; at: number }>();
  return async (docId: string, seqRequis: number) => {
    const previous = last.get(docId);
    if (previous && previous.seqRequis >= seqRequis && now() - previous.at < RESEND_AFTER_MS) return;
    last.set(docId, { seqRequis: Math.max(seqRequis, previous?.seqRequis ?? -1), at: now() });
    await send({ docId, seqRequis });
  };
}

export function sqsSender(queueUrl: string) {
  const sqs = new SQSClient({ region: process.env.AWS_REGION ?? REGION });
  return async (request: PdfRequest) => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(request) }));
  };
}
