import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";

import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { SideMenuController, useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import {
	forwardRef,
	useCallback,
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
import { useDebouncedCallback } from "@/hooks/use-debounced-callback";
import { useThemeMode } from "@/hooks/use-theme-mode";
import {
	bootstrapDocumentCollaboration,
	getDocumentCollaborationStatus,
} from "@/lib/doc-api";
import { useMentionData } from "@/lib/mention-api";
import { cleanBlocks } from "@/lib/utils";

import { DocEditor, type DocEditorHandle } from "./doc-editor";

const DOCUMENT_FRAGMENT_NAME = "document-store";

type PreparedCollaboration =
	| { mode: "collaboration"; ydoc: YDoc }
	| { mode: "read-only-fallback"; reason: "error" | "uninitialized" };

interface CollaborativeDocEditorProps {
	content?: unknown[] | null;
	user: { name: string; color: string };
	editable?: boolean;
	onDirtyChange?: (dirty: boolean) => void;
	onSave?: (blocks: unknown[] | null) => void;
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
	{ ydoc, user, content, editable, onDirtyChange, onSave, projectId, docId },
	ref,
) {
	const { resolvedMode } = useThemeMode();
	const { teamMembers, documents } = useMentionData(projectId);
	const dirtyRef = useRef(false);
	const lastMaterializedRef = useRef(
		JSON.stringify(cleanBlocks(normalizeBlockContent(content ?? null))),
	);
	const provider = useMemo(
		() =>
			new YProvider(window.location.host, docId, ydoc, {
				prefix: `/ws/parties/document-party/${encodeURIComponent(docId)}`,
				disableBc: true,
				maxBackoffTime: 5_000,
			}),
		[docId, ydoc],
	);

	useEffect(() => () => provider.destroy(), [provider]);

	const editor = useCreateBlockNote({
		schema: customSchema,
		collaboration: {
			fragment: ydoc.getXmlFragment(DOCUMENT_FRAGMENT_NAME),
			provider,
			user,
		},
	});

	const save = useCallback(() => {
		if (!editable || !dirtyRef.current) return;
		const blocks = editor.document;
		const isEmpty =
			blocks.length === 1 &&
			blocks[0].type === "paragraph" &&
			Array.isArray(blocks[0].content) &&
			blocks[0].content.length === 0;
		const cleaned = cleanBlocks(isEmpty ? null : (blocks as unknown[]));
		const serialized = JSON.stringify(cleaned);
		dirtyRef.current = false;
		onDirtyChange?.(false);
		if (serialized === lastMaterializedRef.current) return;
		lastMaterializedRef.current = serialized;
		onSave?.(cleaned);
	}, [editable, editor, onDirtyChange, onSave]);

	useImperativeHandle(ref, () => ({ save }), [save]);
	const debouncedSave = useDebouncedCallback(save, 3_000);

	const handleChange = useCallback(() => {
		if (!editable) return;
		dirtyRef.current = true;
		onDirtyChange?.(true);
		debouncedSave();
	}, [debouncedSave, editable, onDirtyChange]);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			if ((event.ctrlKey || event.metaKey) && event.key === "s") {
				event.preventDefault();
				save();
			}
		},
		[save],
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: wrapper captures editor shortcuts
		<div
			data-testid="collaborative-blocknote-editor"
			className="rounded-xl border border-border/25 bg-card/50 hover:border-border/50 transition-all duration-200 overflow-hidden [&_.bn-editor]:min-h-80 [&_.bn-editor]:py-4 [&_.bn-editor]:px-6 [&_.bn-editor]:text-sm [&_.bn-editor]:leading-relaxed"
			onBlur={save}
			onKeyDown={handleKeyDown}
		>
			<BlockNoteView
				editor={editor}
				editable={editable}
				theme={resolvedMode}
				onChange={handleChange}
				sideMenu={false}
			>
				<SideMenuController sideMenu={CustomSideMenu} />
				{editable && (
					<MentionSuggestionMenus
						editor={editor}
						teamMembers={teamMembers}
						projectId={projectId}
						documents={documents}
					/>
				)}
			</BlockNoteView>
		</div>
	);
});

export const CollaborativeDocEditor = forwardRef<
	DocEditorHandle,
	CollaborativeDocEditorProps
>(function CollaborativeDocEditor(
	{ content, user, editable = true, onDirtyChange, onSave, projectId, docId },
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
				if (!cancelled)
					setPrepared({ mode: "read-only-fallback", reason: "error" });
			}
		})();

		return () => {
			cancelled = true;
			ownedDocument?.destroy();
		};
	}, [docId, editable, projectId]);

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
			content={content}
			user={user}
			editable={editable}
			onDirtyChange={onDirtyChange}
			onSave={onSave}
			projectId={projectId}
			docId={docId}
		/>
	);
});
