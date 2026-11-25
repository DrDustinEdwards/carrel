import { Alert, Banner } from "capsomer/react/banner";

export function ActionResult({ result }: { result: { ok: boolean; message: string } | undefined }) {
  if (!result) return null;
  return result.ok ? (
    <Banner tone="ok">{result.message}</Banner>
  ) : (
    <Alert tone="crit">{result.message}</Alert>
  );
}
