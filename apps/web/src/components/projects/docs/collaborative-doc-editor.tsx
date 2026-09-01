import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";

import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { SideMenuController, useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import YProvider from "y-partyserver/provider";
import { encodeStateAsUpdate, Doc as YDoc } from "yjs";

import { CustomSideMenu } from "@/components/shared/blocknote-custom-side-menu";
import { customSchema } from "@/components/shared/blocknote-schema";
import { normalizeBlockContent } from "@/components/shared/comment-blocknote";
import { MentionSuggestionMenus } from "@/components/shared/mention-suggestion-menus";
import { useThemeMode } from "@/hooks/use-theme-mode";
import {
	bootstrapDocumentCollaboration,
	getDocumentCollaborationStatus,
} from "@/lib/doc-api";
import { parseDocumentAgentLeaseStatus } from "@/lib/document-agent-lease";
import { useMentionData } from "@/lib/mention-api";

import { DocEditor, type DocEditorHandle } from "./doc-editor";

const DOCUMENT_FRAGMENT_NAME = "document-store";

type PreparedCollaboration =
	| { mode: "collaboration"; ydoc: YDoc }
	| { mode: "read-only-fallback"; reason: "error" | "uninitialized" };

interface CollaborativeDocEditorProps {
	content?: unknown[] | null;
	user: { name: string; color: string };
	editable?: boolean;
	onConnectionStatusChange?: (
		status: "connected" | "connecting" | "disconnected",
	) => void;
	projectId: string;
	docId: string;
}

function bootstrapYDoc(content: unknown[] | null | undefined): YDoc {
	const conversionEditor = BlockNoteEditor.create({ schema: customSchema });
	const normalized = normalizeBlockContent(content ?? null);
	const blocks =
		normalized.length > 0
			? (normalized as typeof conversionEditor.document)
			: conversionEditor.document;
	return blocksToYDoc(conversionEditor, blocks, DOCUMENT_FRAGMENT_NAME);
}

const CollaborativeEditorSession = forwardRef<
	DocEditorHandle,
	CollaborativeDocEditorProps & { ydoc: YDoc }
>(function CollaborativeEditorSession(
	{ ydoc, user, editable, onConnectionStatusChange, projectId, docId },
	ref,
) {
	const { resolvedMode } = useThemeMode();
	const { teamMembers, documents } = useMentionData(projectId);
	const [leaseStatusKnown, setLeaseStatusKnown] = useState(false);
	const [agentLeaseExpiresAt, setAgentLeaseExpiresAt] = useState<number | null>(
		null,
	);
	const provider = useMemo(
		() =>
			new YProvider(window.location.host, docId, ydoc, {
				prefix: `/ws/parties/document-party/${encodeURIComponent(docId)}`,
				connect: false,
				disableBc: true,
				maxBackoffTime: 5_000,
			}),
		[docId, ydoc],
	);

	useEffect(() => {
		let cancelled = false;
		const handleStatus = (event: {
			status: "connected" | "connecting" | "disconnected";
		}) => {
			onConnectionStatusChange?.(event.status);
			if (event.status !== "connected") setLeaseStatusKnown(false);
		};
		const handleLeaseStatus = (message: string) => {
			const status = parseDocumentAgentLeaseStatus(message);
			if (!status) return;
			setLeaseStatusKnown(true);
			setAgentLeaseExpiresAt(
				status.active &&
					status.expiresAt &&
					status.expiresAt > status.serverTime
					? Date.now() + (status.expiresAt - status.serverTime) + 250
					: null,
			);
		};
		setLeaseStatusKnown(false);
		onConnectionStatusChange?.("connecting");
		provider.on("custom-message", handleLeaseStatus);
		provider.on("status", handleStatus);
		void provider
			.connect()
			.then(() => {
				if (cancelled) provider.destroy();
			})
			.catch(() => {
				if (!cancelled) onConnectionStatusChange?.("disconnected");
			});
		return () => {
			cancelled = true;
			provider.off("custom-message", handleLeaseStatus);
			provider.off("status", handleStatus);
			provider.destroy();
		};
	}, [onConnectionStatusChange, provider]);

	useEffect(() => {
		if (!agentLeaseExpiresAt) return;
		const timeout = window.setTimeout(
			() => setAgentLeaseExpiresAt(null),
			Math.max(0, agentLeaseExpiresAt - Date.now()),
		);
		return () => window.clearTimeout(timeout);
	}, [agentLeaseExpiresAt]);

	const effectiveEditable =
		Boolean(editable) && leaseStatusKnown && agentLeaseExpiresAt === null;

	const editor = useCreateBlockNote({
		schema: customSchema,
		collaboration: {
			fragment: ydoc.getXmlFragment(DOCUMENT_FRAGMENT_NAME),
			provider,
			user,
		},
	});

	useImperativeHandle(ref, () => ({ save: () => undefined }), []);

	return (
		<div className="space-y-3">
			{agentLeaseExpiresAt !== null && (
				<div
					role="status"
					data-testid="document-agent-exclusive-lease"
					className="text-xs text-amber-600 dark:text-amber-400"
				>
					Agent 正在独占编辑此文档，租约结束后将自动恢复编辑。
				</div>
			)}
			<div
				data-testid="collaborative-blocknote-editor"
				className="rounded-xl border border-border/25 bg-card/50 hover:border-border/50 transition-all duration-200 overflow-hidden [&_.bn-editor]:min-h-80 [&_.bn-editor]:py-4 [&_.bn-editor]:px-6 [&_.bn-editor]:text-sm [&_.bn-editor]:leading-relaxed"
			>
				<BlockNoteView
					editor={editor}
					editable={effectiveEditable}
					theme={resolvedMode}
					sideMenu={false}
				>
					<SideMenuController sideMenu={CustomSideMenu} />
					{effectiveEditable && (
						<MentionSuggestionMenus
							editor={editor}
							teamMembers={teamMembers}
							projectId={projectId}
							documents={documents}
						/>
					)}
				</BlockNoteView>
			</div>
		</div>
	);
});

export const CollaborativeDocEditor = forwardRef<
	DocEditorHandle,
	CollaborativeDocEditorProps
>(function CollaborativeDocEditor(
	{
		content,
		user,
		editable = true,
		onConnectionStatusChange,
		projectId,
		docId,
	},
	ref,
) {
	const initialContentRef = useRef(content);
	const [prepared, setPrepared] = useState<PreparedCollaboration | null>(null);

	useEffect(() => {
		let cancelled = false;
		let ownedDocument: YDoc | null = null;
		setPrepared(null);

		void (async () => {
			try {
				const status = await getDocumentCollaborationStatus(projectId, docId);
				if (status.initialized) {
					ownedDocument = new YDoc();
				} else if (editable) {
					const candidate = bootstrapYDoc(initialContentRef.current);
					const result = await bootstrapDocumentCollaboration(
						projectId,
						docId,
						encodeStateAsUpdate(candidate),
					);
					if (result.initialized) {
						ownedDocument = candidate;
					} else {
						candidate.destroy();
						ownedDocument = new YDoc();
					}
				} else {
					if (!cancelled) {
						setPrepared({
							mode: "read-only-fallback",
							reason: "uninitialized",
						});
					}
					return;
				}

				if (cancelled) {
					ownedDocument.destroy();
					ownedDocument = null;
					return;
				}
				setPrepared({ mode: "collaboration", ydoc: ownedDocument });
			} catch {
				if (!cancelled) {
					onConnectionStatusChange?.("disconnected");
					setPrepared({ mode: "read-only-fallback", reason: "error" });
				}
			}
		})();

		return () => {
			cancelled = true;
			ownedDocument?.destroy();
		};
	}, [docId, editable, onConnectionStatusChange, projectId]);

	if (!prepared) {
		return (
			<div
				data-testid="document-collaboration-loading"
				className="min-h-80 animate-pulse rounded-xl border border-border/25 bg-muted/20"
			/>
		);
	}

	if (prepared.mode === "read-only-fallback") {
		return (
			<div className="space-y-3">
				<div
					role="status"
					className="text-xs text-amber-600 dark:text-amber-400"
				>
					{prepared.reason === "uninitialized"
						? "协作文档尚未初始化，当前显示只读业务快照。"
						: "实时协作暂时不可用，当前显示只读业务快照。"}
				</div>
				<DocEditor
					ref={ref}
					content={content}
					editable={false}
					projectId={projectId}
					docId={docId}
				/>
			</div>
		);
	}

	return (
		<CollaborativeEditorSession
			ref={ref}
			ydoc={prepared.ydoc}
			user={user}
			editable={editable}
			onConnectionStatusChange={onConnectionStatusChange}
			projectId={projectId}
			docId={docId}
		/>
	);
});
