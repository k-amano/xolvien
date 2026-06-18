// Human-friendly copy for each cause-based error code. Looked up by the error
// banner; the raw technical detail is never shown here (it goes to the log pane).
import type { ErrorCode } from '../errors'
import type { Lang } from './index'

export interface ErrorCopy {
  title: string   // what happened (short)
  cause: string   // plain-language why
  actions: string[] // concrete recovery steps
}

const ja: Record<ErrorCode, ErrorCopy> = {
  CONTAINER_NOT_RUNNING: {
    title: '作業環境が起動していません',
    cause: 'タスクのコンテナが停止しているため、操作を実行できませんでした。',
    actions: ['少し待ってからもう一度実行してください（環境は自動的に再起動されます）'],
  },
  TIMEOUT: {
    title: '処理が時間内に終わりませんでした',
    cause: '想定より時間がかかり、処理が中断されました。',
    actions: ['もう一度実行してください', '繰り返す場合は、指示を小さく分けてお試しください'],
  },
  CLAUDE_API_ERROR: {
    title: 'AI処理に失敗しました',
    cause: 'Claude との通信が一時的に失敗しました。',
    actions: ['少し待ってからもう一度実行してください'],
  },
  CLAUDE_PERMISSION_LOOP: {
    title: '権限エラーで処理を中断しました',
    cause: 'ファイル権限の問題で同じエラーが繰り返されたため、安全のため停止しました。',
    actions: ['「Reset & Rebuild」で作業環境を作り直してください', '再発する場合はコンテナを再作成してください'],
  },
  GIT_AUTH_FAILED: {
    title: 'Git の認証に失敗しました',
    cause: 'リポジトリへのアクセス権限がありませんでした。',
    actions: ['認証設定（トークンまたは SSH 鍵）を確認してください'],
  },
  GIT_PUSH_REJECTED: {
    title: '変更を反映できませんでした',
    cause: 'リモートに別の変更があるため、push が拒否されました。',
    actions: ['リモートの変更を取り込んでから、もう一度 push してください'],
  },
  TEST_INFRA_ERROR: {
    title: 'テストを実行できませんでした',
    cause: 'テスト環境側の問題（権限不足やモジュール不足など）が発生しました。',
    actions: ['もう一度実行してください', '解消しない場合は「Reset & Rebuild」で作り直してください'],
  },
  NETWORK_ERROR: {
    title: 'サーバーに接続できませんでした',
    cause: '通信が途切れました。',
    actions: ['ネットワーク接続を確認してから、もう一度お試しください'],
  },
  UNKNOWN: {
    title: '予期しないエラーが発生しました',
    cause: '原因を特定できませんでした。',
    actions: ['もう一度実行してください', '続く場合は左ペインのログをご確認ください'],
  },
}

const en: Record<ErrorCode, ErrorCopy> = {
  CONTAINER_NOT_RUNNING: {
    title: 'The workspace is not running',
    cause: "The task's container is stopped, so the operation could not run.",
    actions: ['Wait a moment and try again (the workspace restarts automatically)'],
  },
  TIMEOUT: {
    title: 'The operation timed out',
    cause: 'It took longer than expected and was interrupted.',
    actions: ['Try again', 'If it keeps happening, split your instruction into smaller steps'],
  },
  CLAUDE_API_ERROR: {
    title: 'AI processing failed',
    cause: 'Communication with Claude failed temporarily.',
    actions: ['Wait a moment and try again'],
  },
  CLAUDE_PERMISSION_LOOP: {
    title: 'Stopped due to a permission error',
    cause: 'A file-permission problem caused the same error to repeat, so it was stopped for safety.',
    actions: ['Use "Reset & Rebuild" to recreate the workspace', 'If it recurs, recreate the container'],
  },
  GIT_AUTH_FAILED: {
    title: 'Git authentication failed',
    cause: 'You do not have access to the repository.',
    actions: ['Check your authentication settings (token or SSH key)'],
  },
  GIT_PUSH_REJECTED: {
    title: 'Could not apply your changes',
    cause: 'The remote has other changes, so the push was rejected.',
    actions: ['Pull the remote changes, then push again'],
  },
  TEST_INFRA_ERROR: {
    title: 'Could not run the tests',
    cause: 'A test-environment problem occurred (e.g. missing permissions or modules).',
    actions: ['Try again', 'If it persists, recreate the workspace with "Reset & Rebuild"'],
  },
  NETWORK_ERROR: {
    title: 'Could not reach the server',
    cause: 'The connection was lost.',
    actions: ['Check your network connection and try again'],
  },
  UNKNOWN: {
    title: 'An unexpected error occurred',
    cause: 'The cause could not be determined.',
    actions: ['Try again', 'If it continues, check the log in the left pane'],
  },
}

const catalogs: Record<Lang, Record<ErrorCode, ErrorCopy>> = { ja, en }

export function getErrorCatalog(lang: Lang): Record<ErrorCode, ErrorCopy> {
  return catalogs[lang]
}
