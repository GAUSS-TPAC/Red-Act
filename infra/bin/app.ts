import * as path from "node:path";
import { App, Tags } from "aws-cdk-lib";
import { PROJECT_TAG, REGION } from "@editeur/shared";
import { MainStack } from "../lib/main-stack.ts";

const app = new App();

new MainStack(app, "EditeurPartage", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
  // cdk s'exécute depuis infra/ ; le bundle est produit par `npm run build` à la racine.
  apiBundleDir: path.resolve(process.cwd(), "../packages/api/dist"),
  realtimeBundleDir: path.resolve(process.cwd(), "../packages/realtime/dist"),
});

Tags.of(app).add(PROJECT_TAG.key, PROJECT_TAG.value);
