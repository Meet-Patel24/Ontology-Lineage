import { useState } from "react";
import { api } from "../api/client";
import { GraphView } from "../components/GraphView";
import { ErrorPanel, GraphSkeleton, PageHeader } from "../components/ui";
import { useAsync } from "../lib/useAsync";
import { useApp } from "../store/app";

export function SchemaPage() {
  const schema = useAsync(() => api.schemaGraph(), []);
  const [includeTables, setIncludeTables] = useState(false);
  const concepts = useAsync(() => api.concepts(includeTables), [includeTables]);
  const openInQuery = useApp((s) => s.openInQuery);

  return (
    <div className="flex h-full flex-col overflow-auto p-5">
      <PageHeader
        title="Schema"
        subtitle="The ontology model (labels and relationship types) and the business concepts layered on top."
        cypher={schema.data?.cypher}
      />
      {schema.error && <ErrorPanel code={schema.error.code} message={schema.error.message} />}
      <h2 className="mb-2 text-sm font-semibold">Ontology model</h2>
      {schema.loading && !schema.data ? (
        <GraphSkeleton className="h-[480px]" />
      ) : (
        <GraphView
          data={{ nodes: schema.data?.nodes ?? [], edges: schema.data?.edges ?? [] }}
          layout="force"
          filenameBase="schema"
          className="h-[480px]"
          assetIdOf={() => undefined}
        />
      )}

      <div className="mb-2 mt-6 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Business ontology</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-ink-300">
            <input type="checkbox" checked={includeTables} onChange={(e) => setIncludeTables(e.target.checked)} className="accent-[#001689]" />
            Show tables that REPRESENT each concept
          </label>
          {concepts.data && (
            <button
              onClick={() => openInQuery(concepts.data!.cypher)}
              className="rounded-md border border-ink-600 px-2.5 py-1 text-xs text-ink-200 hover:border-accent hover:text-accent"
            >
              Open in Query
            </button>
          )}
        </div>
      </div>
      {concepts.error && <ErrorPanel code={concepts.error.code} message={concepts.error.message} />}
      {concepts.loading && !concepts.data ? (
        <GraphSkeleton className="h-[480px]" />
      ) : (
        <GraphView
          data={{ nodes: concepts.data?.nodes ?? [], edges: concepts.data?.edges ?? [] }}
          layout="force"
          filenameBase="concepts"
          className="h-[480px]"
          emptyText="No BusinessConcept nodes found."
        />
      )}
    </div>
  );
}
