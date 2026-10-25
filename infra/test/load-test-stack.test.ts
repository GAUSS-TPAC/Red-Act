import * as path from "node:path";
import { App, Tags } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { LOAD_TEST_IP_PARAM, PROJECT_TAG, REGION } from "@editeur/shared";
import { LoadTestStack } from "../lib/load-test-stack.ts";

let template: Template;
beforeAll(() => {
  const app = new App();
  const stack = new LoadTestStack(app, "Charge", {
    env: { account: "123456789012", region: REGION },
    loadBundleDir: path.resolve("tests/load/dist"),
  });
  Tags.of(app).add(PROJECT_TAG.key, PROJECT_TAG.value);
  template = Template.fromStack(stack);
});

describe("LoadTestStack", () => {
  it("une instance c7i-flex.large (offre gratuite), IMDSv2, sans aucun port ouvert", () => {
    template.hasResourceProperties("AWS::EC2::Instance", { InstanceType: "c7i-flex.large" });
    template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateData: Match.objectLike({ MetadataOptions: Match.objectLike({ HttpTokens: "required" }) }),
    });
    expect(JSON.stringify(template.findResources("AWS::EC2::SecurityGroup"))).not.toContain("SecurityGroupIngress");
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
  });

  it("installe k6 épinglé avec vérification de l'empreinte", () => {
    const userData = JSON.stringify(template.findResources("AWS::EC2::Instance"));
    expect(userData).toContain("k6-v2.2.0-linux-amd64.rpm");
    expect(userData).toContain("sha256sum -c");
  });

  it("publie son adresse pour l'exemption anti-abus et un bucket de résultats privé", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: LOAD_TEST_IP_PARAM, Type: "String" });
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
    });
  });

  it("étiquette ses ressources projet=editeur-partage", () => {
    for (const type of ["AWS::EC2::Instance", "AWS::S3::Bucket", "AWS::EC2::VPC"]) {
      for (const r of Object.values(template.findResources(type))) expect(JSON.stringify(r.Properties.Tags)).toContain('"projet"');
    }
  });
});
