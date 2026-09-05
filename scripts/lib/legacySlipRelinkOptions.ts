export class RelinkOptionsError extends Error {
  readonly code = "INVALID_PREPARE_ARGUMENTS";
  constructor() {
    super("INVALID_PREPARE_ARGUMENTS");
  }
}

/** No apply mode, attestation flag, target override, or caller-selected output path. */
export function parseLegacySlipRelinkArgs(
  argv: readonly string[]
): { mode: "help" } | { mode: "prepare"; declaredCodeSha: string } {
  if (argv.length === 1 && argv[0] === "--help") return { mode: "help" };
  const shaArgs = argv.filter(arg => /^--code-sha=[a-f0-9]{40}$/.test(arg));
  if (
    argv.length !== 3 ||
    new Set(argv).size !== 3 ||
    shaArgs.length !== 1 ||
    !argv.includes("--prepare") ||
    !argv.includes("--confirm-preview")
  ) {
    throw new RelinkOptionsError();
  }
  return {
    mode: "prepare",
    declaredCodeSha: shaArgs[0].slice("--code-sha=".length),
  };
}
