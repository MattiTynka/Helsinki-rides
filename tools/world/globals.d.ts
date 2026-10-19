// Khronos glTF-Validator ships without TypeScript declarations.
declare module 'gltf-validator' {
  export interface ValidatorMessage { code: string; message: string; severity: number; pointer?: string }
  export interface ValidatorReport { issues: { numErrors: number; numWarnings: number; numInfos: number; numHints: number; messages: ValidatorMessage[] } }
  export function validateBytes(bytes: Uint8Array, options?: { maxIssues?: number; ignoredIssues?: string[] }): Promise<ValidatorReport>;
}
