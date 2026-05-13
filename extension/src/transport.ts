// extension/src/transport.ts
// Cross-platform IPC endpoint computation for Claws.
// On Unix (darwin/linux): workspace/.claws/claws.sock
// On Windows: \\.\pipe\claws-<sha256[0:8] of workspace root>

import * as crypto from 'crypto';
import * as path from 'path';
import type { NodePlatform } from './platform';

export type Endpoint = string;

/**
 * Compute the IPC endpoint for a given workspace root.
 *
 * Decision 1 (v0.8 blueprint): Windows uses named pipes because Unix sockets
 * are not reliably available on Windows. The sha256[0:8] hash provides a
 * stable, collision-resistant pipe name that encodes workspace identity into
 * the flat \\.\pipe\ namespace. Windows paths are lowercased before hashing
 * because NTFS is case-insensitive.
 *
 * @param workspaceRoot  absolute path to the VS Code workspace folder
 * @param platform       injectable for testing; defaults to process.platform
 */
export function getServerEndpoint(
  workspaceRoot: string,
  platform: NodePlatform | string = process.platform,
): Endpoint {
  if (platform === 'win32') {
    const hash = crypto
      .createHash('sha256')
      .update(workspaceRoot.toLowerCase())
      .digest('hex')
      .slice(0, 8);
    return `\\\\.\\pipe\\claws-${hash}`;
  }
  return path.join(workspaceRoot, '.claws', 'claws.sock');
}

/**
 * True when the endpoint is a Windows named pipe rather than a filesystem path.
 * Used to guard fs.unlink / fs.chmod calls that are no-ops for named pipes.
 */
export function isNamedPipe(endpoint: Endpoint): boolean {
  return endpoint.startsWith('\\\\.\\pipe\\') || endpoint.startsWith('//./pipe/');
}
