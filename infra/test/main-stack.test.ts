import * as path from "node:path";
import { App, Tags } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { PROJECT_TAG, REGION, TABLES } from "@editeur/shared";
import { MainStack } from "../lib/main-stack.ts";

let template: Template;

beforeAll(() => {
  const app = new App();
  const stack = new MainStack(app, "Test", {
    env: { account: "123456789012", region: REGION },
    apiBundleDir: path.resolve("packages/api/dist"),
    realtimeBundleDir: path.resolve("packages/realtime/dist"),
  });
  Tags.of(app).add(PROJECT_TAG.key, PROJECT_TAG.value);
  template = Template.fromStack(stack);
});

type Statement = { Action: string | string[]; Resource: unknown };
const statements = () =>
  Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Statement[],
  );

describe("réseau", () => {
  it("n'a aucune NAT Gateway et deux AZ", () => {
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::EC2::Subnet", 2);
  });

  it("a les endpoints gateway S3 et DynamoDB", () => {
    template.resourceCountIs("AWS::EC2::VPCEndpoint", 2);
    template.allResourcesProperties("AWS::EC2::VPCEndpoint", { VpcEndpointType: "Gateway" });
  });

  it("n'ouvre l'ALB qu'à la liste de préfixes CloudFront", () => {
    template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
      SourcePrefixListId: { Ref: "CloudFrontPrefixListId" },
      FromPort: 80,
      ToPort: 80,
    });
    // Entrées seulement : la sortie des instances reste ouverte (dnf, S3, DynamoDB).
    const ingress = JSON.stringify([
      Object.values(template.findResources("AWS::EC2::SecurityGroup")).map((g) => g.Properties.SecurityGroupIngress),
      template.findResources("AWS::EC2::SecurityGroupIngress"),
    ]);
    expect(ingress).not.toContain('"CidrIp":"0.0.0.0/0"');
  });

  it("n'ouvre jamais le port 22", () => {
    expect(JSON.stringify(template.findResources("AWS::EC2::SecurityGroupIngress"))).not.toMatch(/"FromPort":22\b/);
    expect(JSON.stringify(template.findResources("AWS::EC2::SecurityGroup"))).not.toMatch(/"FromPort":22\b/);
  });
});

describe("données", () => {
  it("crée les 8 tables à la demande", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 8);
    template.allResourcesProperties("AWS::DynamoDB::Table", { BillingMode: "PAY_PER_REQUEST" });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: TABLES.journal.tableName,
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  it("protège le bucket : privé, versionné, SSL obligatoire", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
        ]),
      },
    });
  });
});

describe("IAM au moindre privilège", () => {
  it("n'utilise jamais Resource: *", () => {
    const wildcard = statements().filter((s) => s.Resource === "*");
    expect(wildcard).toEqual([]);
  });

  it("ne donne aucune action DynamoDB générique", () => {
    const actions = statements().flatMap((s) => [s.Action].flat());
    expect(actions.filter((a) => /^dynamodb:\*|^dynamodb:(Batch|Delete)/.test(a))).toEqual([]);
  });

  it("ne lit que les deux paramètres SSM du projet", () => {
    const ssm = statements().filter((s) => [s.Action].flat().includes("ssm:GetParameter"));
    expect(JSON.stringify(ssm)).toContain("parameter/editeur/hmac-secret");
    expect(JSON.stringify(ssm)).toContain("parameter/editeur/admin-token");
  });

  it("n'autorise que l'API à lire les PDF, pas tout le bucket", () => {
    const s3 = statements().filter((s) => [s.Action].flat().some((a) => a.startsWith("s3:GetObject")));
    expect(JSON.stringify(s3)).toContain("/pdf/*");
  });
});

describe("calcul et diffusion", () => {
  it("exige IMDSv2 et une instance t3.micro", () => {
    template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateData: Match.objectLike({
        InstanceType: "t3.micro",
        MetadataOptions: Match.objectLike({ HttpTokens: "required" }),
      }),
    });
  });

  it("vérifie la santé des instances sur /sante", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: "/sante",
      Port: 3000,
    });
  });

  it("bloque /internal* sur l'ALB", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
      Conditions: [Match.objectLike({ PathPatternConfig: { Values: ["/internal*"] } })],
      Actions: [Match.objectLike({ Type: "fixed-response" })],
    });
  });

  it("met en cache les fichiers du front (/assets/*) seulement", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: [
          Match.objectLike({ PathPattern: "/assets/*", CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6" }),
        ],
      }),
    });
  });

  it("ne met rien en cache dans CloudFront et force HTTPS", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          ViewerProtocolPolicy: "redirect-to-https",
        }),
      }),
    });
  });
});

describe("serveur temps réel", () => {
  const realtimeAsg = () =>
    Object.values(template.findResources("AWS::AutoScaling::AutoScalingGroup")).find(
      (r) => r.Properties.MaxSize === "1",
    )!;

  it("une seule instance t3.small, IMDSv2", () => {
    template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateData: Match.objectLike({
        InstanceType: "t3.small",
        MetadataOptions: Match.objectLike({ HttpTokens: "required" }),
      }),
    });
    expect(realtimeAsg().Properties).toMatchObject({ MinSize: "1", MaxSize: "1" });
  });

  it("mise à jour : l'ancienne instance est arrêtée avant la nouvelle", () => {
    expect(realtimeAsg().UpdatePolicy.AutoScalingRollingUpdate).toMatchObject({
      MinInstancesInService: 0,
      MaxBatchSize: 1,
    });
  });

  it("/collab* est routé vers le serveur temps réel, santé sur /sante", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
      Conditions: [Match.objectLike({ PathPatternConfig: { Values: ["/collab*"] } })],
      Actions: [Match.objectLike({ Type: "forward" })],
    });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: "/sante",
      Port: 1234,
    });
  });

  it("le rôle temps réel n'écrit que le journal, le document, les crédits, les versions et les instantanés", () => {
    const policies = Object.entries(template.findResources("AWS::IAM::Policy")).filter(([id]) =>
      id.startsWith("RealtimeRole"),
    );
    const json = JSON.stringify(policies);
    for (const table of ["documents", "journal", "credits", "versions"]) expect(json).toContain(`Table${table}`);
    for (const table of ["links", "reservations", "blocks"]) expect(json).not.toContain(`Table${table}`);
    expect(json).toContain("/snapshots/*");
    expect(json).not.toContain("admin-token");
  });
});

describe("file pdf-requests (C3)", () => {
  const policyOf = (prefix: string) =>
    JSON.stringify(Object.entries(template.findResources("AWS::IAM::Policy")).filter(([id]) => id.startsWith(prefix)));

  it("chiffrée, courte durée de vie, long polling", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "editeur-pdf-requests",
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 3600,
      ReceiveMessageWaitTimeSeconds: 20,
    });
  });

  it("l'API envoie, le serveur temps réel lit et écrit les PDF", () => {
    const api = policyOf("ApiRole");
    const realtime = policyOf("RealtimeRole");
    expect(api).toContain("sqs:SendMessage");
    expect(api).not.toContain("sqs:ReceiveMessage");
    expect(realtime).toContain("sqs:ReceiveMessage");
    expect(realtime).toContain("sqs:DeleteMessage");
    expect(realtime).not.toContain("sqs:SendMessage");
    expect(realtime).toContain("/pdf/*");
  });

  it("les PDF expirent au bout d'un jour", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ Prefix: "pdf/", ExpirationInDays: 1, Status: "Enabled" })]),
      },
    });
  });
});

describe("tags", () => {
  it("étiquette les ressources projet=editeur-partage", () => {
    for (const type of [
      "AWS::DynamoDB::Table",
      "AWS::S3::Bucket",
      "AWS::EC2::VPC",
      "AWS::AutoScaling::AutoScalingGroup",
      "AWS::SQS::Queue",
    ]) {
      const resources = Object.values(template.findResources(type));
      expect(resources.length).toBeGreaterThan(0);
      for (const r of resources) {
        expect(JSON.stringify(r.Properties.Tags)).toContain('"projet"');
      }
    }
  });
});
