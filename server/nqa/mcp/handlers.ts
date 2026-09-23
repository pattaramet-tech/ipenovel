import { NQA_CAPABILITIES, type NqaCapability } from "../controlPlane";
import type { NqaAuthenticatedPrincipal } from "./contracts";

export type NqaGatewayHandlerContext = {
  principal: NqaAuthenticatedPrincipal;
  requestId: string;
  correlationId: string;
  capability: NqaCapability;
  target: {
    row?: number | null;
    novelId?: string | null;
    bundleId?: string | null;
    chapter?: number | null;
  };
  inputFingerprint: string | null;
};

export type NqaGatewayHandler = (
  context: NqaGatewayHandlerContext
) => Promise<unknown> | unknown;

export class NqaGatewayHandlerRegistry {
  private readonly handlers: Partial<Record<NqaCapability, NqaGatewayHandler>>;

  constructor(
    handlers: Partial<Record<NqaCapability, NqaGatewayHandler>> = {}
  ) {
    for (const capability of Object.keys(handlers)) {
      if (!(capability in NQA_CAPABILITIES)) {
        throw new Error(
          "Handler registry contains a non-allowlisted capability."
        );
      }
    }

    this.handlers = { ...handlers };
  }

  get(capability: NqaCapability): NqaGatewayHandler | null {
    return this.handlers[capability] ?? null;
  }

  has(capability: NqaCapability): boolean {
    return Boolean(this.handlers[capability]);
  }

  capabilities(): NqaCapability[] {
    return Object.keys(this.handlers) as NqaCapability[];
  }
}
