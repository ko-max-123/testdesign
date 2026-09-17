from __future__ import annotations

import ctypes
import json
import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Optional


@dataclass
class CheckResult:
    name: str
    status: str   # OK / WARN / NG / INFO
    detail: str


def is_windows() -> bool:
    return platform.system().lower() == "windows"


def is_admin() -> bool:
    if not is_windows():
        return False
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def run_powershell(script: str, timeout: int = 20) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def command_exists_ps(command: str) -> bool:
    cp = run_powershell(
        f"$c = Get-Command {command} -ErrorAction SilentlyContinue; "
        f"if ($null -ne $c) {{ 'YES' }} else {{ 'NO' }}"
    )
    return cp.returncode == 0 and "YES" in cp.stdout


def check_python() -> CheckResult:
    version = sys.version.split()[0]
    major, minor = sys.version_info[:2]
    if (major, minor) >= (3, 10):
        return CheckResult("Python", "OK", f"Python {version}")
    return CheckResult(
        "Python",
        "WARN",
        f"Python {version}。推奨は Python 3.10 以上です。"
    )


def check_admin() -> CheckResult:
    if is_admin():
        return CheckResult("管理者権限", "OK", "現在のプロセスは管理者権限で実行されています。")
    return CheckResult(
        "管理者権限",
        "WARN",
        "現在は通常権限です。QoS設定の作成・削除時には管理者権限が必要です。"
    )


def check_powershell() -> CheckResult:
    exe = shutil.which("powershell.exe")
    if exe:
        return CheckResult("PowerShell", "OK", exe)
    return CheckResult("PowerShell", "NG", "powershell.exe が見つかりません。")


def check_qos_cmdlets() -> CheckResult:
    required = ["Get-NetQosPolicy", "New-NetQosPolicy", "Remove-NetQosPolicy"]
    missing = [c for c in required if not command_exists_ps(c)]
    if not missing:
        return CheckResult(
            "Windows QoSコマンド",
            "OK",
            "Get/New/Remove-NetQosPolicy が利用可能です。"
        )
    return CheckResult(
        "Windows QoSコマンド",
        "NG",
        "利用できないコマンド: " + ", ".join(missing)
    )


def check_icssvc() -> CheckResult:
    script = r"""
$svc = Get-Service -Name icssvc -ErrorAction SilentlyContinue
if ($null -eq $svc) {
    [pscustomobject]@{ Exists=$false; Status=''; StartType='' } | ConvertTo-Json -Compress
} else {
    $cim = Get-CimInstance Win32_Service -Filter "Name='icssvc'" -ErrorAction SilentlyContinue
    [pscustomobject]@{
        Exists=$true
        Status=$svc.Status.ToString()
        StartType=if ($null -ne $cim) { $cim.StartMode } else { '' }
    } | ConvertTo-Json -Compress
}
"""
    cp = run_powershell(script)
    if cp.returncode != 0 or not cp.stdout.strip():
        return CheckResult(
            "Mobile Hotspot Service (icssvc)",
            "WARN",
            "サービス状態を取得できませんでした。"
        )

    try:
        data = json.loads(cp.stdout)
    except json.JSONDecodeError:
        return CheckResult(
            "Mobile Hotspot Service (icssvc)",
            "WARN",
            "サービス情報を解析できませんでした。"
        )

    if not data.get("Exists"):
        return CheckResult(
            "Mobile Hotspot Service (icssvc)",
            "NG",
            "icssvc が見つかりません。モバイルホットスポット機能が利用できない可能性があります。"
        )

    status = data.get("Status", "")
    start_type = data.get("StartType", "")

    if str(start_type).lower() == "disabled":
        return CheckResult(
            "Mobile Hotspot Service (icssvc)",
            "NG",
            f"サービスは存在しますが無効化されています。Status={status}, StartType={start_type}"
        )

    return CheckResult(
        "Mobile Hotspot Service (icssvc)",
        "OK",
        f"Status={status}, StartType={start_type}"
    )


def check_wifi_adapter() -> CheckResult:
    script = r"""
$items = Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
Where-Object {
    $_.InterfaceDescription -match 'Wireless|Wi-Fi|802\.11|WiFi' -or
    $_.Name -match 'Wi-Fi|Wireless|ワイヤレス'
} |
Select-Object Name,InterfaceDescription,Status,MacAddress |
ConvertTo-Json -Compress
"""
    cp = run_powershell(script)

    if cp.returncode != 0 or not cp.stdout.strip():
        return CheckResult(
            "Wi-Fiアダプタ",
            "NG",
            "Wi-Fiアダプタを検出できませんでした。"
        )

    try:
        data = json.loads(cp.stdout)
        if isinstance(data, dict):
            data = [data]
    except json.JSONDecodeError:
        return CheckResult(
            "Wi-Fiアダプタ",
            "WARN",
            "アダプタ情報を解析できませんでした。"
        )

    if not data:
        return CheckResult("Wi-Fiアダプタ", "NG", "Wi-Fiアダプタがありません。")

    details = []
    up_found = False
    for row in data:
        details.append(
            f"{row.get('Name','?')} / {row.get('Status','?')} / "
            f"{row.get('InterfaceDescription','?')}"
        )
        if str(row.get("Status", "")).lower() == "up":
            up_found = True

    status = "OK" if up_found else "WARN"
    detail = " | ".join(details[:4])
    if not up_found:
        detail += " / 現在UpのWi-Fiアダプタは確認できません。"

    return CheckResult("Wi-Fiアダプタ", status, detail)


def check_mobile_hotspot_policy() -> CheckResult:
    """
    既知の代表的なポリシー候補を読み取り専用で確認する。
    企業環境ではMDM/GPOの実装差があるため、ここだけで完全判定はしない。
    """
    script = r"""
$paths = @(
    'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Network Connections',
    'HKLM:\SOFTWARE\Microsoft\PolicyManager\default\WiFi',
    'HKLM:\SOFTWARE\Microsoft\PolicyManager\current\device\WiFi'
)

$result = @()

foreach ($p in $paths) {
    if (Test-Path $p) {
        $props = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue
        foreach ($prop in $props.PSObject.Properties) {
            if (
                $prop.Name -match 'ICS|InternetConnectionSharing|Hotspot|Tether|WiFi' -or
                $prop.Name -eq 'NC_ShowSharedAccessUI'
            ) {
                $result += [pscustomobject]@{
                    Path=$p
                    Name=$prop.Name
                    Value=[string]$prop.Value
                }
            }
        }
    }
}

$result | ConvertTo-Json -Compress
"""
    cp = run_powershell(script)
    if cp.returncode != 0:
        return CheckResult(
            "会社ポリシー候補",
            "WARN",
            "レジストリ上のポリシー候補を確認できませんでした。"
        )

    raw = cp.stdout.strip()
    if not raw:
        return CheckResult(
            "会社ポリシー候補",
            "INFO",
            "代表的な関連ポリシー値は検出されませんでした。"
        )

    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            data = [data]
    except json.JSONDecodeError:
        return CheckResult(
            "会社ポリシー候補",
            "WARN",
            "関連ポリシー情報の解析に失敗しました。"
        )

    items = [
        f"{x.get('Name')}={x.get('Value')} ({x.get('Path')})"
        for x in data[:8]
    ]

    return CheckResult(
        "会社ポリシー候補",
        "WARN",
        "関連しそうな設定値が見つかりました。値だけでは禁止/許可を断定できません: "
        + " | ".join(items)
    )


def check_existing_qos_policies() -> CheckResult:
    script = r"""
Get-NetQosPolicy -PolicyStore ActiveStore -ErrorAction SilentlyContinue |
Select-Object Name,ThrottleRate,IPSrcPrefixMatchCondition,IPDstPrefixMatchCondition |
ConvertTo-Json -Compress
"""
    cp = run_powershell(script)

    if cp.returncode != 0:
        return CheckResult(
            "既存QoSポリシー",
            "WARN",
            "既存QoSポリシーを取得できませんでした。"
        )

    if not cp.stdout.strip():
        return CheckResult(
            "既存QoSポリシー",
            "OK",
            "ActiveStore上のQoSポリシーは確認されませんでした。"
        )

    try:
        data = json.loads(cp.stdout)
        if isinstance(data, dict):
            data = [data]
    except json.JSONDecodeError:
        return CheckResult(
            "既存QoSポリシー",
            "WARN",
            "QoSポリシー一覧を解析できませんでした。"
        )

    names = [str(x.get("Name", "?")) for x in data]
    return CheckResult(
        "既存QoSポリシー",
        "INFO",
        f"{len(names)}件あります: " + ", ".join(names[:10])
    )


def check_mobile_hotspot_settings_hint() -> CheckResult:
    """
    設定画面そのものが操作可能かは、PowerShellだけで確実には判定できない。
    必要な関連コンポーネントを確認し、最終確認はユーザー操作とする。
    """
    return CheckResult(
        "モバイルホットスポット設定",
        "INFO",
        "最終確認が必要です: Windows 設定 > ネットワークとインターネット > "
        "モバイル ホットスポット を開き、ONにできるか確認してください。"
    )


def print_result(result: CheckResult):
    marks = {
        "OK": "[ OK ]",
        "WARN": "[WARN]",
        "NG": "[ NG ]",
        "INFO": "[INFO]",
    }
    print(f"{marks.get(result.status, '[----]')} {result.name}")
    print(f"       {result.detail}")


def overall_result(results: list[CheckResult]) -> tuple[str, str]:
    if any(r.status == "NG" for r in results):
        return (
            "× 制限または不足あり",
            "NG項目を確認してください。会社ポリシーや端末管理による制限の可能性があります。"
        )

    important_warns = {
        "管理者権限",
        "Windows QoSコマンド",
        "Mobile Hotspot Service (icssvc)",
        "Wi-Fiアダプタ",
        "会社ポリシー候補",
    }

    if any(r.status == "WARN" and r.name in important_warns for r in results):
        return (
            "△ 要確認",
            "基本機能はありますが、権限・ポリシー・サービス状態の確認が必要です。"
        )

    return (
        "○ 利用可能性高い",
        "少なくとも読み取り診断上は大きな問題は見つかりませんでした。"
    )


def main():
    print("=" * 68)
    print(" LowSpeedWiFiLab - Environment Check")
    print(" Python + Windows標準機能版")
    print("=" * 68)
    print()

    if not is_windows():
        print("[ NG ] OS")
        print("       このツールはWindows 10/11向けです。")
        input("\nEnterキーで終了します...")
        return 1

    results = [
        check_python(),
        check_powershell(),
        check_admin(),
        check_qos_cmdlets(),
        check_icssvc(),
        check_wifi_adapter(),
        check_existing_qos_policies(),
        check_mobile_hotspot_policy(),
        check_mobile_hotspot_settings_hint(),
    ]

    for result in results:
        print_result(result)
        print()

    title, detail = overall_result(results)

    print("-" * 68)
    print("総合判定")
    print(f"  {title}")
    print(f"  {detail}")
    print("-" * 68)

    print()
    print("重要:")
    print("  このスクリプトは診断目的で、QoSポリシーの作成・削除は行いません。")
    print("  会社PCでは、GPO / MDM / EDR / VPN / セキュリティ製品によって")
    print("  実際のモバイルホットスポットやICSが制限される場合があります。")
    print()
    print("次の手動確認:")
    print("  1. Windows 設定を開く")
    print("  2. ネットワークとインターネット")
    print("  3. モバイル ホットスポット")
    print("  4. 実際にONへ切り替えられるか確認")
    print()

    input("Enterキーで終了します...")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
