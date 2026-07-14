import { DocumentWorkspace } from "@/components/editor/DocumentWorkspace";

/**
 * The document route.
 *
 * A Server Component that renders a client island. It deliberately does NOT fetch the document: the
 * document lives in IndexedDB, and fetching it here would make the first paint wait on a network round
 * trip — which is precisely the thing this product exists not to do.
 *
 * The server's job is to ship the shell. The client's job is to have the document already.
 */
export default async function DocumentPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <DocumentWorkspace documentId={id} />;
}
