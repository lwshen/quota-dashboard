import { NextResponse } from "next/server";
import { listDescriptors } from "@quota/core";

export const runtime = "nodejs";

export async function GET() {
  const providers = listDescriptors().map((d) => ({
    provider: d.provider,
    label: d.label,
    producesRateWindows: d.producesRateWindows,
    credentialFields: d.credentialFields,
  }));
  return NextResponse.json({ providers });
}
