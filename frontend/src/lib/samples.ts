export interface SampleQuery {
  title: string;
  description: string;
  query: string;
}

export const SAMPLE_QUERIES: SampleQuery[] = [
  {
    title: "Ontology model",
    description: "The meta-graph: which labels connect to which.",
    query: "CALL db.schema.visualization()",
  },
  {
    title: "Business concepts",
    description: "BusinessConcept nodes and how they relate.",
    query: "MATCH p = (:BusinessConcept)-[:RELATED_TO]->(:BusinessConcept)\nRETURN p",
  },
  {
    title: "Table-level lineage",
    description: "Pipelines, their activities and the tables / views they read and write.",
    query:
      "MATCH p = (:Pipeline)-[:CONTAINS]->(:Activity)-[:READS_FROM|WRITES_TO]->(:Table|View)\nOPTIONAL MATCH v = (:Table)-[:FEEDS]->(:View)\nRETURN p, v",
  },
  {
    title: "Column lineage of risk_bucket",
    description: "Up to three hops of FLOWS_TO into fact.loan_portfolio.risk_bucket.",
    query:
      "MATCH p = (:Table)-[:HAS_COLUMN]->(:Column)-[:FLOWS_TO*1..3]->(c:Column {table:'fact.loan_portfolio', name:'risk_bucket'})\nRETURN p",
  },
  {
    title: "Impact of banking.customers",
    description: "Where every column of banking.customers ends up.",
    query:
      "MATCH p = (:Table {full_name:'banking.customers'})-[:HAS_COLUMN]->(:Column)-[:FLOWS_TO*1..3]->(:Column)<-[:HAS_COLUMN]-(:Table)\nRETURN p",
  },
  {
    title: "PII policy check",
    description: "Table result: every PII flow with an OK / VIOLATION status.",
    query:
      "MATCH (c:Column {is_pii:true})-[f:FLOWS_TO]->(d:Column)\nRETURN c.table, c.name, f.transformation, d.table, d.name,\n  CASE WHEN f.transformation IN ['DIRECT','CAST'] AND d.platform STARTS WITH 'Fabric'\n       THEN 'VIOLATION' ELSE 'OK' END AS status",
  },
  {
    title: "Pipeline view",
    description: "Every pipeline → activity → source / target.",
    query: "MATCH p = (:Pipeline)-[:CONTAINS]->(:Activity)-[:READS_FROM|WRITES_TO]->()\nRETURN p",
  },
  {
    title: "Column search",
    description: "Columns whose name contains 'customer'.",
    query:
      "MATCH (t)-[:HAS_COLUMN]->(c:Column)\nWHERE toLower(c.name) CONTAINS 'customer'\nRETURN t.full_name, c.name, c.platform, c.is_pii",
  },
];
