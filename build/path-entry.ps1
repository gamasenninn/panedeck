# インストーラが PATH を通す（2026-10-11）。`code .` と同じく `panedeck .` で起動できるように。
#
# installer.nsh から呼ばれる: -Action add（入れたとき）/ -Action remove（外したとき）。
# 試験は tests/unit/path-entry.spec.ts。
#
# ★ ユーザーの PATH はレジストリ（HKCU\Environment の Path）を直接読み書きする。
#   [Environment]::SetEnvironmentVariable は値を展開済みで読み、REG_SZ で書くので、
#   `%USERPROFILE%\bin` のような項目が今の値に焼き付いてしまう。
# ★ 自分の 1 項目以外には触らない（空の項目も並びもそのまま残す）。
param(
  [Parameter(Mandatory = $true)][ValidateSet("add", "remove")][string]$Action,
  [Parameter(Mandatory = $true)][string]$Dir,
  # 渡すと、レジストリに触らず新しい値だけを出力する（試験用）
  [AllowEmptyString()][string]$Value,
  # 書き込み先のキー。試験は別のキーを渡す
  [string]$Key = "HKCU:\Environment"
)

function Test-SameDir([string]$a, [string]$b) {
  return $a.TrimEnd("\").Equals($b.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)
}

function Update-PathValue([string]$current, [string]$action, [string]$dir) {
  $entries = @()
  if ($current -ne "") { $entries = $current.TrimEnd(";") -split ";" }
  $mine = @($entries | Where-Object { Test-SameDir $_ $dir })
  if ($action -eq "add") {
    if ($mine.Count -gt 0) { return $current }
    return (@($entries) + $dir | Where-Object { $_ -ne $null }) -join ";"
  }
  if ($mine.Count -eq 0) { return $current }
  return (@($entries | Where-Object { -not (Test-SameDir $_ $dir) })) -join ";"
}

if ($PSBoundParameters.ContainsKey("Value")) {
  Write-Output (Update-PathValue $Value $Action $Dir)
  exit 0
}

if (-not (Test-Path $Key)) { New-Item -Path $Key -Force | Out-Null }
$item = Get-Item $Key
$current = [string]$item.GetValue("Path", "", "DoNotExpandEnvironmentNames")
$kind = if ($item.GetValueNames() -contains "Path") { $item.GetValueKind("Path") } else { "ExpandString" }
$next = Update-PathValue $current $Action $Dir
if ($next -ceq $current -and $item.GetValueNames() -contains "Path") { exit 0 }

New-ItemProperty -Path $Key -Name "Path" -PropertyType $kind -Value $next -Force | Out-Null

# 開いているエクスプローラなどに「環境変数が変わった」と知らせる（新しく開く窓が拾う）。
# SetEnvironmentVariable は書いたあとに WM_SETTINGCHANGE を流すので、使い捨ての名前で借りる
if ($Key -eq "HKCU:\Environment") {
  [Environment]::SetEnvironmentVariable("PANEDECK_PATH_REFRESH", "1", "User")
  [Environment]::SetEnvironmentVariable("PANEDECK_PATH_REFRESH", $null, "User")
}