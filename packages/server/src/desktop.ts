/**
 * 데스크톱(Electron) 셸이 서버에 알려주는 상태.
 *
 * 컨트롤 패널은 웹 페이지라서 전역 단축키가 실제로 걸렸는지 알 방법이 없다.
 * Electron 메인 프로세스가 여기에 결과를 적어두면 `/api/status` 로 흘러나간다.
 *
 * 단축키 등록은 조용히 실패한다 — 다른 프로그램이 이미 그 조합을 쓰고 있으면
 * 그냥 안 걸릴 뿐 아무 메시지도 없다. 방송 중에 눌렀는데 아무 일도 안 일어나는 게
 * 가장 나쁜 실패라, 등록 결과를 반드시 UI 로 되돌려줘야 한다.
 */

export interface HotkeyStatus {
  action: string;
  accelerator: string;
  registered: boolean;
}

export interface DesktopStatus {
  /** Electron 셸 위에서 돌고 있는가 (false 면 그냥 서버만 떠 있는 것) */
  present: boolean;
  hotkeys: HotkeyStatus[];
}

let status: DesktopStatus = { present: false, hotkeys: [] };

export function setDesktopStatus(next: DesktopStatus): void {
  status = next;
}

export function getDesktopStatus(): DesktopStatus {
  return status;
}
