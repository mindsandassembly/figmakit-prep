/**
 * FigmaKit Standards — handoff attestation service.
 *
 * A Figma plugin runs locally under the designer's control, so nothing it
 * produces can be trusted as proof that a file passed validation: the
 * report's `contentHash` is an integrity checksum, not a signature. Real
 * attestation requires a server that re-validates independently.
 *
 * Integration contract for a trusted implementation:
 *  - `submit(report)` POSTs the HandoffReport as the JSON request body
 *    (Content-Type: application/json) to the organization's attestation endpoint.
 *  - The server MUST NOT trust the submitted issues/readiness. It should:
 *      1. fetch the file via the Figma REST API (GET /v1/files/:fileKey, with
 *         plugin_data=shared so the `figmakit_standards` sharedPluginData
 *         namespace — config, registry, exceptions, readiness — is included),
 *      2. re-run the same ruleset/registry versions named in the report over the
 *         report's scope.rootNodeIds,
 *      3. compare its result with the submitted report (configHash, totals,
 *         blocking violations, approved exceptions),
 *      4. respond `{ accepted, attestationId, message }`, where attestationId
 *         identifies a server-side signed record.
 *  - Network access requires `networkAccess.allowedDomains` in manifest.json.
 */

import type { HandoffReport } from './types';

export interface HandoffSubmissionResult {
  accepted: boolean;
  /** Server-issued attestation record id; null when not attested. */
  attestationId: string | null;
  message: string;
}

export interface HandoffAttestationService {
  readonly name: string;
  /** True only for services that independently re-validate server-side. */
  readonly trusted: boolean;
  submit(report: HandoffReport): Promise<HandoffSubmissionResult>;
}

/**
 * Default service: no server is configured, so nothing is attested. The report
 * can still be exported locally, but it is self-reported by the plugin.
 */
export class LocalOnlyHandoffService implements HandoffAttestationService {
  readonly name = 'local-only';
  readonly trusted = false;

  submit(report: HandoffReport): Promise<HandoffSubmissionResult> {
    var hash = report && typeof report.contentHash === 'string' ? report.contentHash : 'unknown';
    return Promise.resolve({
      accepted: false,
      attestationId: null,
      message:
        'No attestation service is configured. The handoff report (content hash ' + hash + ') was produced locally ' +
        'by the plugin and is not independently verified; configure a server that re-validates the file via the ' +
        'Figma REST API to obtain a trusted attestation.',
    });
  }
}
