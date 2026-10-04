/**
 * os/windows-acl.mjs — Windows owner-only ACL の適用と検証 (唯一の正本)
 *
 * runtime-error-store と completed-turn-receipts が同一の PowerShell ACL
 * 実装を別々に持っていたため (env 変数名だけ違う事故フォーク)、ここへ集約する。
 *
 * apply script は適用直後に同一 process 内で read-back 検証まで行う。
 * 検証内容: owner = current SID、explicit rule が current SID の
 * FullControl Allow 1 本だけ、継承 rule なし。
 *
 * CI 実測で PowerShell コールドスタートが 3.0〜3.2 秒に達し 3 秒 cap と衝突して
 * flake したため timeout は 15 秒 (run 29586852389 / 29628634501)。
 * explicit failure 契約は不変: 非 0 exit は例外にする。
 *
 * 注意: テストは `childProcess.spawnSync` を node:child_process の default
 * export 経由で mock するため、named import に変えないこと。
 */
import childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { linkSync, rmSync, writeFileSync } from 'node:fs';
import { platform as hostPlatform } from 'node:os';

export const WINDOWS_ACL_TIMEOUT_MS = 15_000;

export function isWindows(env = process.env) {
  return env.OS === 'Windows_NT' || hostPlatform() === 'win32';
}

export function applyAndVerifyWindowsAcl(path, directory) {
  runWindowsAclScript(path, directory, WINDOWS_ACL_APPLY_SCRIPT);
}

export function verifyWindowsAcl(path, directory) {
  runWindowsAclScript(path, directory, WINDOWS_ACL_VERIFY_SCRIPT);
}

/**
 * owner-only ACL の付いた空 file を、最終 path へ排他的に作る。作れたら true、既に在れば false。
 *
 * 最終 path へ作ってから ACL を適用すると、適用が終わるまで (PowerShell の起動で 1 秒前後)
 * 継承 ACL のまま見える。同時に走った別 process がその間に verify して落ちた
 * (fox 2026-10-05、Cursor が同じ Stop hook を 2 本同時に起動)。別名で作って ACL を
 * 適用・検証し、hard link で公開する。hard link は同じ file なので ACL はそのまま付く。
 */
export function createWindowsPrivateFile(path) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, '', { encoding: 'utf8', flag: 'wx' });
    applyAndVerifyWindowsAcl(temporary, false);
    try {
      linkSync(temporary, path);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return false;
    }
  } finally {
    rmSync(temporary, { force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function runWindowsAclScript(path, directory, script) {
  const result = childProcess.spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, THROUGHLINE_ACL_PATH: path, THROUGHLINE_ACL_DIRECTORY: directory ? '1' : '0' },
    stdio: 'ignore', timeout: WINDOWS_ACL_TIMEOUT_MS, windowsHide: true,
  });
  if (result.status !== 0) throw new Error('Windows owner-only ACL verification failed');
}

const WINDOWS_ACL_VERIFY_SCRIPT = String.raw`
$p=$env:THROUGHLINE_ACL_PATH; $isDir=$env:THROUGHLINE_ACL_DIRECTORY -eq '1'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl=Get-Acl -LiteralPath $p
$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if($owner -ne $sid){exit 41}; $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); if($rules.Count -ne 1){exit 42}
$r=$rules[0]; if($r.IdentityReference.Value -ne $sid -or $r.AccessControlType -ne 'Allow' -or $r.IsInherited -or ($r.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl){exit 43}
`;

const WINDOWS_ACL_APPLY_SCRIPT = String.raw`
$p=$env:THROUGHLINE_ACL_PATH; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$isDir=$env:THROUGHLINE_ACL_DIRECTORY -eq '1'; $acl=if($isDir){New-Object System.Security.AccessControl.DirectorySecurity}else{New-Object System.Security.AccessControl.FileSecurity}; $acl.SetAccessRuleProtection($true,$false)
$flags=if($isDir){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None}
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$flags,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.SetOwner($sid); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl
` + WINDOWS_ACL_VERIFY_SCRIPT;
