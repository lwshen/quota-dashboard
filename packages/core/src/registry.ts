import type { ProviderDescriptor } from "./adapter";
import type { UsageProvider } from "./model";
import { antigravityDescriptor, claudeDescriptor, codex2Descriptor, codexDescriptor, grokDescriptor, kimiDescriptor, moonshotDescriptor, rightapiDescriptor } from "./providers";

// Key order drives dashboard card order.
const DESCRIPTORS: Record<UsageProvider, ProviderDescriptor> = {
  codex: codexDescriptor,
  codex2: codex2Descriptor,
  claude: claudeDescriptor,
  antigravity: antigravityDescriptor,
  grok: grokDescriptor,
  rightapi: rightapiDescriptor,
  kimi: kimiDescriptor,
  moonshot: moonshotDescriptor,
};

export const ALL_PROVIDERS = Object.keys(DESCRIPTORS) as UsageProvider[];

export function getDescriptor(p: UsageProvider): ProviderDescriptor {
  const d = DESCRIPTORS[p];
  if (!d) throw new Error(`unknown provider: ${p}`);
  return d;
}

export function listDescriptors(): ProviderDescriptor[] {
  return ALL_PROVIDERS.filter((p) => p !== "codex2").map((p) => DESCRIPTORS[p]);
}

export function isProvider(v: string): v is UsageProvider {
  return Object.prototype.hasOwnProperty.call(DESCRIPTORS, v);
}
