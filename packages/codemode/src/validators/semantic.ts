import { experimentalAnalyze } from "workerd-oxc";
import type {
  CodemodeValidationIssue,
  CodemodeValidationResult,
  CodeValidationContext,
  CodemodeValidator
} from "../validation";
import { AMBIENT_SANDBOX_GLOBALS, BUILTIN_PROVIDER_GLOBALS } from "./globals";

export type SemanticValidatorOptions = {
  /** Name reported on diagnostics. Defaults to `"semantic"`. */
  name?: string;
  /**
   * Extra identifiers that are injected into the sandbox scope beyond the
   * configured connectors and the built-in `codemode` provider — for example
   * the names of custom providers registered on the runtime. Without these,
   * references to them would be reported as unknown connectors.
   */
  allowedGlobals?: readonly string[];
  /** Maximum number of issues to report. Defaults to 10. */
  maxIssues?: number;
};

const DEFAULT_MAX_ISSUES = 10;

/**
 * A code validator that rejects generated programs referencing connectors that
 * are not configured on the runtime. Such code parses fine but throws the
 * moment it runs (e.g. `slack is not defined`), so rejecting it here avoids a
 * wasted dynamic Worker execution.
 *
 * Detection uses the Oxc semantic analyzer (`workerd-oxc`): connectors are
 * injected as sandbox globals, so a reference to an unconfigured connector
 * appears as an unresolved identifier. Ambient JavaScript/Workers globals and
 * the built-in `codemode` provider are subtracted from that set.
 */
export function semanticValidator(
  options: SemanticValidatorOptions = {}
): CodemodeValidator {
  const name = options.name ?? "semantic";
  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  const extraGlobals = options.allowedGlobals ?? [];

  return {
    name,
    async validateCode(
      context: CodeValidationContext
    ): Promise<CodemodeValidationResult> {
      const analyzed = await experimentalAnalyze({
        filename: "codemode.js",
        source: context.normalizedCode,
        lang: "js"
      });

      // If analysis could not run (e.g. the program does not parse), defer to
      // the syntax validator rather than reporting a misleading semantic error.
      if (!analyzed.ok) return { valid: true };

      const connectorNames = context.connectors.map((c) => c.name);
      const allowed = new Set<string>([
        ...AMBIENT_SANDBOX_GLOBALS,
        ...BUILTIN_PROVIDER_GLOBALS,
        ...extraGlobals,
        ...connectorNames
      ]);

      const issues: CodemodeValidationIssue[] = [];
      const reported = new Set<string>();

      for (const ref of analyzed.value.unresolved) {
        if (allowed.has(ref.name)) continue;
        if (reported.has(ref.name)) continue;
        reported.add(ref.name);
        if (issues.length >= maxIssues) break;
        issues.push(unknownConnectorIssue(ref, connectorNames, context));
      }

      return issues.length > 0 ? { valid: false, issues } : { valid: true };
    }
  };
}

function unknownConnectorIssue(
  ref: { name: string; span?: { start: number; end: number } },
  connectorNames: readonly string[],
  context: CodeValidationContext
): CodemodeValidationIssue {
  const available =
    connectorNames.length > 0
      ? `Available connectors: ${connectorNames.join(", ")}.`
      : "No connectors are configured.";
  const path = ref.span
    ? formatLocation(context.normalizedCode, ref.span.start)
    : undefined;
  return {
    message: `"${ref.name}" is not an available connector or defined variable.`,
    code: "unknown-connector",
    suggestion: available,
    ...(path ? { path } : {})
  };
}

/**
 * Convert a UTF-16 string offset into a 1-based `line:column` label for
 * diagnostics. `experimentalAnalyze` reports spans as string offsets.
 */
function formatLocation(source: string, offset: number): string {
  let line = 1;
  let column = 1;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return `${line}:${column}`;
}
