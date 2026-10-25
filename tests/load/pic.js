// Pic de visiteurs (C5, C6) — k6, lancé à l'heure d'ouverture du lien.
//   15 000 visiteurs : 12 000 dans la première minute (200/s), 3 000 sur les 4 suivantes.
//   Chaque visiteur (cookies propres) clique, puis suit les réponses jusqu'à un état
//   final : télécharge (200) ou épuisé (410). 202 / 425 / 429 : il rappelle après
//   Retry-After. Au 410, il s'arrête (C6 : plus aucune sollicitation).
//
//   k6 run -e BASE_URL=https://xxx.cloudfront.net -e LINK_ID=… -e OUT=pic.json pic.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

// 410 (épuisé), 425 (pas ouvert), 429 (bloqué) sont des réponses normales : seules les
// erreurs serveur et réseau comptent comme des échecs.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 410, 425, 429));

const BASE = __ENV.BASE_URL;
const LINK = __ENV.LINK_ID;

const telecharge = new Counter("visiteurs_telecharge");
const epuise = new Counter("visiteurs_epuise");
const sansReponse = new Counter("visiteurs_sans_reponse_finale");
const exemplaires = new Counter("exemplaires_reserves"); // réponses 200/202 qui posent un ticket (C1)
const rappels = new Counter("rappels");
const tempsReponse = new Trend("temps_jusqu_a_reponse_finale", true);
const temps410 = new Trend("temps_reponse_epuise", true);

export const options = {
  discardResponseBodies: false,
  scenarios: {
    pic: {
      executor: "ramping-arrival-rate",
      startRate: 200,
      timeUnit: "1s",
      preAllocatedVUs: 400,
      maxVUs: 3000,
      stages: [
        { target: 200, duration: "60s" }, // 12 000 visiteurs
        { target: 12, duration: "10s" },
        { target: 12, duration: "230s" }, // ~3 000 visiteurs
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    visiteurs_sans_reponse_finale: ["count==0"],
    temps_reponse_epuise: ["p(95)<1000"],
  },
};

export default function () {
  const jar = new http.CookieJar(); // un visiteur = un navigateur neuf
  const url = `${BASE}/api/links/${LINK}/claim`;
  const start = Date.now();
  for (let i = 0; i < 60; i++) {
    const res = http.post(url, null, { jar, tags: { name: "claim" } });
    check(res, { "réponse attendue (200/202/410/425/429)": (r) => [200, 202, 410, 425, 429].includes(r.status) });
    // Un nouveau ticket n'est posé qu'au clic qui réserve : un par exemplaire consommé.
    if ((res.status === 200 || res.status === 202) && res.cookies.ticket) exemplaires.add(1);
    if (res.status === 200) {
      telecharge.add(1);
      tempsReponse.add(Date.now() - start);
      return;
    }
    if (res.status === 410) {
      epuise.add(1);
      temps410.add(res.timings.duration);
      tempsReponse.add(Date.now() - start);
      return; // C6 : on n'interroge plus
    }
    if (![202, 425, 429].includes(res.status)) break;
    rappels.add(1);
    sleep(Math.min(10, Number(res.headers["Retry-After"]) || 2));
  }
  sansReponse.add(1);
}

export function handleSummary(data) {
  return { [__ENV.OUT || "pic.json"]: JSON.stringify(data, null, 2), stdout: textSummary(data) };
}

function textSummary(data) {
  const m = data.metrics;
  const v = (name, field = "count") => (m[name] ? m[name].values[field] : 0);
  return [
    `visiteurs servis (200) : ${v("visiteurs_telecharge")}`,
    `visiteurs « épuisé » (410) : ${v("visiteurs_epuise")}`,
    `sans réponse finale : ${v("visiteurs_sans_reponse_finale")}`,
    `exemplaires réservés (réponses avec nouveau ticket) : ${v("exemplaires_reserves")}`,
    `rappels : ${v("rappels")}`,
    `requêtes : ${v("http_reqs")} ; échecs : ${(v("http_req_failed", "rate") * 100).toFixed(2)} %`,
    `durée p95 des requêtes : ${Math.round(v("http_req_duration", "p(95)"))} ms ; 410 p95 : ${Math.round(v("temps_reponse_epuise", "p(95)"))} ms`,
    "",
  ].join("\n");
}
