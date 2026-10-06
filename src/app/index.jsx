import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppLayout } from "@/shell/layout";
import { useAppMenu } from "@/shell/menu-context";
import { themeViewItems, useTheme } from "@/lib/theme";
import { useAppDialog } from "@/shell/dialog";
import { useSearchParam, useUpdateSearchParams } from "@/lib/url-query-state";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ScrollArea } from "@/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { MenubarItem, MenubarSeparator, MenubarShortcut } from "@/ui/menubar";
import {
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconEye,
  IconFolder,
  IconList,
  IconLoader2,
  IconMaximize,
  IconMovie,
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconStar,
  IconTrash,
  IconUpload,
  IconVideo,
  IconX,
} from "@/ui/icons";
import * as api from "./client";
import {
  continueWatching,
  foldersFor,
  formatBytes,
  formatDate,
  formatDuration,
  formatShape,
  progressFraction,
  subtitleFor,
  tagsFor,
  videoMatches,
} from "./library";
import { Player } from "./player";

const ACCEPT =
  "video/mp4,video/webm,video/quicktime,video/x-matroska,video/x-m4v,video/x-msvideo,video/mpeg,.avi,.m4v,.mkv,.mov,.mp4,.mpeg,.mpg,.ogv,.webm,.wmv,.3gp";
const VIEWS = [
  "all",
  "continue",
  "favorites",
  "folder",
  "collection",
  "tag",
  "trash",
];

function countLabel(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

export default function VideosPage() {
  const dialog = useAppDialog();
  const updateSearchParams = useUpdateSearchParams();
  const viewParam = useSearchParam("view");
  const folderParam = useSearchParam("folder");
  const collectionParam = Number(useSearchParam("collection")) || null;
  const tagParam = useSearchParam("tag");
  const openParam = useSearchParam("video");
  const queryParam = useSearchParam("q") || "";

  const [library, setLibrary] = useState({
    videos: [],
    collections: [],
    trash: [],
    videosDir: "",
  });
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busyPath, setBusyPath] = useState(null);
  const [query, setQuery] = useState(queryParam);
  const fileInputRef = useRef(null);

  const view = VIEWS.includes(viewParam) ? viewParam : "all";
  const videos = library.videos;

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      setLibrary(await api.fetchLibrary());
    } catch (error) {
      toast.error(error.message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setQuery(queryParam);
  }, [queryParam]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (query.trim() !== queryParam)
        updateSearchParams({ q: query.trim() || null });
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [query, queryParam, updateSearchParams]);

  const folders = useMemo(() => foldersFor(videos), [videos]);
  const tags = useMemo(() => tagsFor(videos), [videos]);
  const collection = useMemo(
    () =>
      library.collections.find((entry) => entry.id === collectionParam) || null,
    [collectionParam, library.collections],
  );
  const folder = useMemo(
    () => folders.find((entry) => entry.key === folderParam) || null,
    [folderParam, folders],
  );

  const visible = useMemo(() => {
    const base =
      view === "continue"
        ? continueWatching(videos)
        : view === "favorites"
          ? videos.filter((video) => video.favorite)
          : view === "collection" && collection
            ? collection.paths
                .map((path) => videos.find((video) => video.path === path))
                .filter(Boolean)
            : view === "folder" && folder
              ? folder.videos
              : view === "tag" && tagParam
                ? videos.filter((video) => video.tags.includes(tagParam))
                : videos;
    return queryParam
      ? base.filter((video) => videoMatches(video, queryParam))
      : base;
  }, [collection, folder, queryParam, tagParam, videos, view]);

  const current = useMemo(
    () => videos.find((video) => video.path === openParam) || null,
    [openParam, videos],
  );

  const [dockedPath, setDockedPath] = useState(null);
  const [lastOpen, setLastOpen] = useState(null);
  const [endedPath, setEndedPath] = useState(null);
  if (openParam !== lastOpen) {
    setLastOpen(openParam);
    setDockedPath(openParam || lastOpen === endedPath ? null : lastOpen);
  }
  const dockedVideo = videos.find((video) => video.path === dockedPath) || null;
  const playing = current || dockedVideo;
  const docked = !current && Boolean(dockedVideo);

  const queue = useMemo(
    () => (visible.length ? visible : videos),
    [videos, visible],
  );
  const currentIndex = current
    ? queue.findIndex((video) => video.path === current.path)
    : -1;
  const playingIndex = playing
    ? queue.findIndex((video) => video.path === playing.path)
    : -1;

  const openView = useCallback(
    (nextView, extra = {}) => {
      updateSearchParams({
        view: nextView === "all" ? null : nextView,
        folder: null,
        collection: null,
        tag: null,
        video: null,
        ...extra,
      });
    },
    [updateSearchParams],
  );

  const openVideo = useCallback(
    (video) =>
      updateSearchParams({ video: video?.path || null }, { mode: "push" }),
    [updateSearchParams],
  );
  const closeVideo = useCallback(
    () => updateSearchParams({ video: null }),
    [updateSearchParams],
  );

  const playRelative = useCallback(
    (delta) => {
      if (playingIndex < 0) return;
      const next = queue[playingIndex + delta];
      if (!next) return;
      if (current) openVideo(next);
      else setDockedPath(next.path);
    },
    [current, openVideo, playingIndex, queue],
  );

  const applyProgress = useCallback((path, patch) => {
    setLibrary((previous) => ({
      ...previous,
      videos: previous.videos.map((video) =>
        video.path === path
          ? {
              ...video,
              position: patch.watched ? 0 : (patch.time ?? video.position),
              duration: patch.duration ?? video.duration,
              width: patch.width ?? video.width,
              height: patch.height ?? video.height,
              watched: patch.watched ?? video.watched,
              playedAt: new Date().toISOString(),
            }
          : video,
      ),
    }));
  }, []);

  const applyPoster = useCallback((path) => {
    setLibrary((previous) => ({
      ...previous,
      videos: previous.videos.map((video) =>
        video.path === path ? { ...video, poster: "frame" } : video,
      ),
    }));
  }, []);

  const toggleFavorite = useCallback(async (video) => {
    setBusyPath(video.path);
    try {
      await api.setFavorite(video.path, !video.favorite);
      setLibrary((previous) => ({
        ...previous,
        videos: previous.videos.map((entry) =>
          entry.path === video.path
            ? { ...entry, favorite: !video.favorite }
            : entry,
        ),
      }));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusyPath(null);
    }
  }, []);

  const editVideo = useCallback(
    async (video) => {
      const title = await dialog.prompt({
        title: "Title",
        defaultValue: video.title,
        inputLabel: "Title",
        confirmLabel: "Next",
      });
      if (title === null) return;
      const description = await dialog.prompt({
        title: "Description",
        defaultValue: video.description,
        inputLabel: "Description",
        confirmLabel: "Next",
      });
      if (description === null) return;
      const tags = await dialog.prompt({
        title: "Tags",
        defaultValue: video.tags.join(", "),
        inputLabel: "Comma separated",
        confirmLabel: "Save",
      });
      if (tags === null) return;
      try {
        await api.updateVideo(video.path, { title, description, tags });
        await load({ quiet: true });
        toast.success("Saved (the file itself is untouched)");
      } catch (error) {
        toast.error(error.message);
      }
    },
    [dialog, load],
  );

  const resetVideo = useCallback(
    async (video) => {
      try {
        await api.updateVideo(video.path, { reset: true });
        await load({ quiet: true });
        toast.success("Back to what the file says");
      } catch (error) {
        toast.error(error.message);
      }
    },
    [load],
  );

  const removeVideo = useCallback(
    async (video) => {
      const confirmed = await dialog.confirm({
        title: `Move "${video.title}" to the trash?`,
        description:
          "It leaves the videos folder but stays on disk until you empty the trash.",
        confirmLabel: "Move to trash",
        tone: "destructive",
      });
      if (!confirmed) return;
      try {
        const result = await api.trashVideos([video.path]);
        if (current?.path === video.path) {
          const next =
            queue[currentIndex + 1] || queue[currentIndex - 1] || null;
          updateSearchParams({
            video: next && next.path !== video.path ? next.path : null,
          });
        }
        await load({ quiet: true });
        toast.success("Moved to the trash", {
          action: {
            label: "Undo",
            onClick: () => {
              void api
                .restoreTrash(result.batchId)
                .then(() => load({ quiet: true }))
                .catch((error) => toast.error(error.message));
            },
          },
        });
      } catch (error) {
        toast.error(error.message);
      }
    },
    [current, currentIndex, dialog, load, queue, updateSearchParams],
  );

  const restoreBatch = useCallback(
    async (batch) => {
      try {
        await api.restoreTrash(batch.id);
        await load({ quiet: true });
        toast.success("Put back");
      } catch (error) {
        toast.error(error.message);
      }
    },
    [load],
  );

  const clearTrash = useCallback(async () => {
    const confirmed = await dialog.confirm({
      title: "Empty the trash?",
      description: "The files are deleted from disk. This cannot be undone.",
      confirmLabel: "Empty trash",
      tone: "destructive",
    });
    if (!confirmed) return;
    try {
      const result = await api.emptyTrash();
      await load({ quiet: true });
      toast.success(`Deleted ${countLabel(result.removed, "file")}`);
    } catch (error) {
      toast.error(error.message);
    }
  }, [dialog, load]);

  const newCollection = useCallback(
    async (paths = []) => {
      const name = await dialog.prompt({
        title: "New collection",
        defaultValue: "",
        inputLabel: "Name",
        confirmLabel: "Create",
      });
      if (!name) return;
      try {
        const { collection: created } = await api.createCollection(name, paths);
        await load({ quiet: true });
        toast.success(`Created ${created.name}`);
      } catch (error) {
        toast.error(error.message);
      }
    },
    [dialog, load],
  );

  const addToCollection = useCallback(
    async (target, video) => {
      try {
        await api.updateCollection(target.id, { add: [video.path] });
        await load({ quiet: true });
        toast.success(`Added to ${target.name}`);
      } catch (error) {
        toast.error(error.message);
      }
    },
    [load],
  );

  const removeFromCollection = useCallback(
    async (target, video) => {
      try {
        await api.updateCollection(target.id, { remove: [video.path] });
        await load({ quiet: true });
      } catch (error) {
        toast.error(error.message);
      }
    },
    [load],
  );

  const renameCollection = useCallback(
    async (target) => {
      const name = await dialog.prompt({
        title: "Rename collection",
        defaultValue: target.name,
        inputLabel: "Name",
        confirmLabel: "Rename",
      });
      if (!name) return;
      try {
        await api.updateCollection(target.id, { name });
        await load({ quiet: true });
      } catch (error) {
        toast.error(error.message);
      }
    },
    [dialog, load],
  );

  const removeCollection = useCallback(
    async (target) => {
      const confirmed = await dialog.confirm({
        title: `Delete "${target.name}"?`,
        description: "The collection goes; the videos stay where they are.",
        confirmLabel: "Delete",
        tone: "destructive",
      });
      if (!confirmed) return;
      try {
        await api.deleteCollection(target.id);
        openView("all");
        await load({ quiet: true });
      } catch (error) {
        toast.error(error.message);
      }
    },
    [dialog, load, openView],
  );

  const rescan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await api.rescanLibrary();
      await load({ quiet: true });
      toast.success(
        `${countLabel(result.count, "file")}, ${result.probed} newly read`,
      );
    } catch (error) {
      toast.error(error.message);
    } finally {
      setScanning(false);
    }
  }, [load]);

  const upload = useCallback(
    async (files) => {
      const list = Array.from(files || []).filter((file) => file.size > 0);
      if (!list.length) return;
      setUploading(true);
      try {
        const result = await api.uploadFiles(list);
        await load({ quiet: true });
        if (result.uploaded.length)
          toast.success(`Added ${countLabel(result.uploaded.length, "video")}`);
        for (const rejected of result.rejected) toast.error(rejected.error);
      } catch (error) {
        toast.error(error.message);
      } finally {
        setUploading(false);
      }
    },
    [load],
  );

  const pickFiles = useCallback(() => fileInputRef.current?.click(), []);

  const copyLink = useCallback(async (video) => {
    try {
      await navigator.clipboard.writeText(
        new URL(video.url, window.location.href).href,
      );
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy the link");
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (
        isTypingTarget(event.target) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (event.key === "/") {
        event.preventDefault();
        document.getElementById("videos-search")?.focus();
      } else if (event.key === "Escape" && current) {
        closeVideo();
      } else if (event.key === "Escape" && docked) {
        setDockedPath(null);
      } else if (event.key === "n" && playing) {
        playRelative(1);
      } else if (event.key === "p" && playing) {
        playRelative(-1);
      } else if (event.key === "Enter" && !current && visible.length) {
        openVideo(visible[0]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeVideo, current, docked, openVideo, playRelative, playing, visible]);

  const heading = current
    ? current.title
    : view === "continue"
      ? "Continue watching"
      : view === "favorites"
        ? "Favorites"
        : view === "trash"
          ? "Trash"
          : view === "collection"
            ? collection?.name || "Collection"
            : view === "folder"
              ? folder?.name || "Folder"
              : view === "tag"
                ? `#${tagParam}`
                : "All videos";

  const totalSize = useMemo(
    () => visible.reduce((sum, video) => sum + video.size, 0),
    [visible],
  );
  const subheading = current
    ? subtitleFor(current)
    : view === "trash"
      ? countLabel(
          library.trash.reduce((sum, batch) => sum + batch.count, 0),
          "file",
        )
      : `${countLabel(visible.length, "video")} / ${formatBytes(totalSize)}`;

  return (
    <AppLayout showHeader={false}>
      <VideoMenus
        onUpload={pickFiles}
        onRescan={rescan}
        onNewCollection={() => void newCollection()}
        onView={openView}
        onClose={closeVideo}
        onDismiss={() => setDockedPath(null)}
        onNext={() => playRelative(1)}
        onPrevious={() => playRelative(-1)}
        view={view}
        hasOpen={Boolean(current)}
        hasDocked={docked}
        hasNext={playingIndex >= 0 && playingIndex < queue.length - 1}
        hasPrevious={playingIndex > 0}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => {
          void upload(event.target.files);
          event.target.value = "";
        }}
      />
      <div
        className="relative flex h-full min-h-0"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void upload(event.dataTransfer.files);
        }}
      >
        <aside className="hidden w-56 shrink-0 flex-col rule-r md:flex">
          <ScrollArea className="min-h-0 flex-1" viewportClassName="py-1">
            <p className="flex h-8 items-center px-3 text-muted-foreground uppercase">
              Library
            </p>
            <SidebarItem
              icon={IconMovie}
              label="All videos"
              count={videos.length}
              active={view === "all"}
              onClick={() => openView("all")}
            />
            <SidebarItem
              icon={IconPlayerPlay}
              label="Continue"
              count={continueWatching(videos).length}
              active={view === "continue"}
              onClick={() => openView("continue")}
            />
            <SidebarItem
              icon={IconStar}
              label="Favorites"
              count={videos.filter((video) => video.favorite).length}
              active={view === "favorites"}
              onClick={() => openView("favorites")}
            />
            <SidebarItem
              icon={IconTrash}
              label="Trash"
              count={library.trash.reduce((sum, batch) => sum + batch.count, 0)}
              active={view === "trash"}
              onClick={() => openView("trash")}
            />

            {folders.length > 1 ? (
              <>
                <p className="mt-2 flex h-8 items-center px-3 text-muted-foreground uppercase">
                  Folders
                </p>
                {folders.map((entry) => (
                  <SidebarItem
                    key={entry.key || "root"}
                    icon={IconFolder}
                    label={entry.name}
                    count={entry.videos.length}
                    active={view === "folder" && folderParam === entry.key}
                    onClick={() =>
                      openView("folder", { folder: entry.key || "" })
                    }
                  />
                ))}
              </>
            ) : null}

            <div className="mt-2 flex h-8 items-center justify-between px-3">
              <p className="text-muted-foreground uppercase">Collections</p>
              <button
                type="button"
                onClick={() => void newCollection()}
                className="grid size-6 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="New collection"
                title="New collection"
              >
                <IconPlus className="size-4" />
              </button>
            </div>
            {library.collections.length === 0 ? (
              <p className="px-3 py-2 text-muted-foreground">None yet.</p>
            ) : null}
            {library.collections.map((entry) => (
              <SidebarItem
                key={entry.id}
                icon={IconList}
                label={entry.name}
                count={entry.paths.length}
                active={view === "collection" && collectionParam === entry.id}
                onClick={() =>
                  openView("collection", { collection: String(entry.id) })
                }
              />
            ))}

            {tags.length ? (
              <>
                <p className="mt-2 flex h-8 items-center px-3 text-muted-foreground uppercase">
                  Tags
                </p>
                <div className="flex flex-wrap gap-1 px-3 pb-2">
                  {tags.map((entry) => (
                    <button
                      key={entry.tag}
                      type="button"
                      onClick={() => openView("tag", { tag: entry.tag })}
                      className={cn(
                        "frame px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground",
                        view === "tag" &&
                          tagParam === entry.tag &&
                          "bg-muted text-foreground",
                      )}
                    >
                      {entry.tag}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </ScrollArea>
          {library.videosDir ? (
            <p
              className="truncate rule-t px-3 py-2 text-muted-foreground"
              title={library.videosDir}
            >
              {library.videosDir}
            </p>
          ) : null}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 rule-b px-3">
            <div className="relative min-w-0 flex-1 md:max-w-sm">
              <IconSearch className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="videos-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search title, folder, tag"
                className="h-8 pl-7"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <IconX className="size-4" />
                </button>
              ) : null}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={rescan}
                disabled={scanning}
                className="h-8 gap-2"
              >
                <IconRefresh
                  className={cn("size-4", scanning && "animate-spin")}
                />
                <span className="hidden sm:inline">Rescan</span>
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={pickFiles}
                disabled={uploading}
                className="h-8 gap-2"
              >
                {uploading ? (
                  <IconLoader2 className="size-4 animate-spin" />
                ) : (
                  <IconUpload className="size-4" />
                )}
                Upload
              </Button>
            </div>
          </div>

          <div className="flex shrink-0 items-end justify-between gap-4 px-3 py-4">
            <div className="min-w-0">
              {current ? (
                <button
                  type="button"
                  onClick={closeVideo}
                  className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  <IconChevronLeft className="size-3" />
                  Back to the library
                </button>
              ) : null}
              <h1 className="truncate">{heading}</h1>
              <p className="truncate text-muted-foreground">{subheading}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {view === "collection" && collection ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void renameCollection(collection)}
                    className="h-8"
                  >
                    Rename
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void removeCollection(collection)}
                    className="h-8 hover:bg-destructive hover:text-destructive-foreground"
                  >
                    Delete
                  </Button>
                </>
              ) : null}
              {view === "trash" && library.trash.length ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={clearTrash}
                  className="h-8 hover:bg-destructive hover:text-destructive-foreground"
                >
                  Empty trash
                </Button>
              ) : null}
            </div>
          </div>

          {playing ? (
            <div
              className={
                docked
                  ? "fixed right-4 bottom-4 z-30 w-80 bg-background frame shadow-lg"
                  : "shrink-0"
              }
            >
              {docked ? (
                <div className="flex h-8 items-center gap-1 rule-b pr-1 pl-3">
                  <button
                    type="button"
                    onClick={() => openVideo(playing)}
                    className="min-w-0 flex-1 truncate text-left"
                    title={playing.title}
                  >
                    {playing.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => openVideo(playing)}
                    className="grid size-6 shrink-0 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Back to the video"
                    title="Back to the video"
                  >
                    <IconMaximize className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDockedPath(null)}
                    className="grid size-6 shrink-0 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Close the player"
                    title="Close the player"
                  >
                    <IconX className="size-4" />
                  </button>
                </div>
              ) : null}
              <Player
                video={playing}
                className={
                  docked ? "aspect-video w-full" : "aspect-video w-full frame"
                }
                style={
                  docked ? undefined : { height: "round(down, 56dvh, 4px)" }
                }
                onProgress={applyProgress}
                onPoster={applyPoster}
                onPlay={() => setEndedPath(null)}
                onEnded={(video) => {
                  setEndedPath(video.path);
                  playRelative(1);
                }}
              />
            </div>
          ) : null}

          <ScrollArea className="min-h-0 flex-1" viewportClassName="pb-4">
            {loading ? (
              <p className="px-3 py-10 text-muted-foreground">
                Reading the library…
              </p>
            ) : current ? (
              <WatchDetails
                video={current}
                queue={queue}
                index={currentIndex}
                collections={library.collections}
                inCollection={view === "collection" ? collection : null}
                busy={busyPath === current.path}
                onOpen={openVideo}
                onStar={() => void toggleFavorite(current)}
                onEdit={() => void editVideo(current)}
                onReset={() => void resetVideo(current)}
                onCopy={() => void copyLink(current)}
                onDelete={() => void removeVideo(current)}
              />
            ) : view === "trash" ? (
              <TrashView trash={library.trash} onRestore={restoreBatch} />
            ) : videos.length === 0 ? (
              <EmptyLibrary
                videosDir={library.videosDir}
                onUpload={pickFiles}
              />
            ) : visible.length === 0 ? (
              <p className="px-3 py-10 text-muted-foreground">
                {queryParam
                  ? "Nothing matches."
                  : view === "favorites"
                    ? "Star a video to keep it here."
                    : view === "continue"
                      ? "Start something and it waits for you here."
                      : "Nothing here."}
              </p>
            ) : (
              <div
                className="grid gap-4 px-3"
                style={{
                  gridTemplateColumns: "repeat(auto-fill, 256px)",
                }}
              >
                {visible.map((video) => (
                  <VideoCard
                    key={video.path}
                    video={video}
                    busy={busyPath === video.path}
                    collections={library.collections}
                    inCollection={view === "collection" ? collection : null}
                    onOpen={() => openVideo(video)}
                    onStar={() => void toggleFavorite(video)}
                    onEdit={() => void editVideo(video)}
                    onReset={() => void resetVideo(video)}
                    onCopy={() => void copyLink(video)}
                    onDelete={() => void removeVideo(video)}
                    onAddToCollection={(target) =>
                      void addToCollection(target, video)
                    }
                    onNewCollection={() => void newCollection([video.path])}
                    onRemoveFromCollection={
                      view === "collection" && collection
                        ? () => void removeFromCollection(collection, video)
                        : null
                    }
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </section>

        {dragging ? (
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-background/80 backdrop-blur-sm">
            <div className="border border-dashed border-foreground/50 px-6 py-4">
              Drop video files to add them
            </div>
          </div>
        ) : null}
      </div>
    </AppLayout>
  );
}

function VideoMenus({
  onUpload,
  onRescan,
  onNewCollection,
  onView,
  onClose,
  onDismiss,
  onNext,
  onPrevious,
  view,
  hasOpen,
  hasDocked,
  hasNext,
  hasPrevious,
}) {
  const theme = useTheme();
  useAppMenu(
    {
      file: [
        { id: "upload", label: "Upload video…", onSelect: onUpload },
        { id: "rescan", label: "Rescan library", onSelect: onRescan },
        { id: "sep", kind: "separator" },
        {
          id: "collection",
          label: "New collection…",
          onSelect: onNewCollection,
        },
      ],
      menus: [
        {
          id: "watch",
          label: "Watch",
          content: (
            <>
              <MenubarItem disabled={!hasNext} onClick={onNext}>
                Next video
                <MenubarShortcut>N</MenubarShortcut>
              </MenubarItem>
              <MenubarItem disabled={!hasPrevious} onClick={onPrevious}>
                Previous video
                <MenubarShortcut>P</MenubarShortcut>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem disabled={!hasOpen} onClick={onClose}>
                Back to the library
                <MenubarShortcut>Esc</MenubarShortcut>
              </MenubarItem>
              <MenubarItem disabled={!hasDocked} onClick={onDismiss}>
                Close the player
                <MenubarShortcut>Esc</MenubarShortcut>
              </MenubarItem>
            </>
          ),
        },
      ],
      view: [
        {
          id: "all",
          kind: "checkbox",
          label: "All videos",
          checked: view === "all",
          onSelect: () => onView("all"),
        },
        {
          id: "continue",
          kind: "checkbox",
          label: "Continue watching",
          checked: view === "continue",
          onSelect: () => onView("continue"),
        },
        {
          id: "favorites",
          kind: "checkbox",
          label: "Favorites",
          checked: view === "favorites",
          onSelect: () => onView("favorites"),
        },
        {
          id: "trash",
          kind: "checkbox",
          label: "Trash",
          checked: view === "trash",
          onSelect: () => onView("trash"),
        },
        { id: "theme-sep", kind: "separator" },
        ...themeViewItems(theme),
      ],
    },
    [theme.id, view, hasOpen, hasDocked, hasNext, hasPrevious],
  );
  return null;
}

function SidebarItem({ icon: Icon, label, count, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-muted/60",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {typeof count === "number" ? (
        <span className="text-muted-foreground/80">{count}</span>
      ) : null}
    </button>
  );
}

function Poster({ video, className }) {
  return (
    <span className={cn("relative block overflow-hidden bg-muted", className)}>
      <img
        src={video.posterUrl}
        alt=""
        loading="lazy"
        draggable={false}
        className="size-full object-cover"
      />
      {video.duration ? (
        <span className="absolute right-1 bottom-1 bg-black/75 px-1 text-white">
          {formatDuration(video.duration)}
        </span>
      ) : null}
      {video.watched ? (
        <span
          className="absolute top-1 right-1 grid size-6 place-items-center bg-black/70 text-white"
          title="Watched"
        >
          <IconEye className="size-3" />
        </span>
      ) : null}
      {progressFraction(video) > 0 ? (
        <span className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
          <span
            className="block h-full bg-foreground"
            style={{ width: `${progressFraction(video) * 100}%` }}
          />
        </span>
      ) : null}
    </span>
  );
}

function VideoActions({
  video,
  collections,
  inCollection,
  onEdit,
  onReset,
  onCopy,
  onDelete,
  onAddToCollection,
  onNewCollection,
  onRemoveFromCollection,
  align = "end",
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="grid size-8 place-items-center border border-transparent text-muted-foreground transition hover:border-border hover:bg-background hover:text-foreground data-[popup-open]:border-border data-[popup-open]:bg-background"
        aria-label="Video actions"
        title="More"
      >
        <IconList className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-48">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <IconPlus className="size-4" /> Add to collection
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {collections.map((entry) => (
              <DropdownMenuItem
                key={entry.id}
                onClick={() => onAddToCollection(entry)}
                disabled={entry.paths.includes(video.path)}
              >
                {entry.name}
              </DropdownMenuItem>
            ))}
            {collections.length ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onClick={onNewCollection}>
              <IconPlus className="size-4" /> New collection…
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {onRemoveFromCollection ? (
          <DropdownMenuItem onClick={onRemoveFromCollection}>
            <IconX className="size-4" /> Remove from {inCollection?.name}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onEdit}>
          <IconPencil className="size-4" /> Edit details…
        </DropdownMenuItem>
        {video.edited ? (
          <DropdownMenuItem onClick={onReset}>
            <IconRefresh className="size-4" /> Use the file name
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={onCopy}>
          <IconCopy className="size-4" /> Copy link
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <IconTrash className="size-4" /> Move to trash
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function VideoCard({ video, busy, onOpen, onStar, ...actions }) {
  return (
    <div className="group flex min-w-0 flex-col inset-ring-1 inset-ring-border bg-card transition hover:inset-ring-foreground/40">
      <button type="button" onClick={onOpen} className="block text-left">
        <Poster video={video} className="aspect-video w-full" />
      </button>
      <div className="flex min-w-0 items-start gap-1 p-2">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left"
        >
          <p className="truncate">{video.title}</p>
          <p className="truncate text-muted-foreground">{subtitleFor(video)}</p>
        </button>
        <button
          type="button"
          onClick={onStar}
          disabled={busy}
          className={cn(
            "grid size-6 shrink-0 place-items-center text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-wait",
            video.favorite && "text-amber-300",
          )}
          aria-label={
            video.favorite ? "Remove from favorites" : "Add to favorites"
          }
          aria-pressed={video.favorite}
        >
          <IconStar
            className={cn("size-4", video.favorite && "fill-current")}
          />
        </button>
        <VideoActions video={video} {...actions} />
      </div>
    </div>
  );
}

function WatchDetails({
  video,
  queue,
  index,
  busy,
  onOpen,
  onStar,
  onEdit,
  ...actions
}) {
  const next = queue.slice(index + 1, index + 9);
  return (
    <div className="flex min-w-0 flex-col gap-4 pt-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          {video.description ? <p>{video.description}</p> : null}
          <dl className="mt-2 flex flex-wrap gap-x-4 text-muted-foreground">
            <span>{formatDuration(video.duration) || "Length unknown"}</span>
            {formatShape(video) ? <span>{formatShape(video)}</span> : null}
            <span>{formatBytes(video.size)}</span>
            <span>{formatDate(video.updatedAt)}</span>
            <span>{video.path}</span>
          </dl>
          {video.tags.length ? (
            <p className="mt-2 flex flex-wrap gap-1">
              {video.tags.map((tag) => (
                <span
                  key={tag}
                  className="frame px-2 py-1 text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onStar}
            disabled={busy}
            className={cn("h-8 gap-2", video.favorite && "text-amber-300")}
          >
            <IconStar
              className={cn("size-4", video.favorite && "fill-current")}
            />
            {video.favorite ? "Starred" : "Star"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onEdit}
            className="h-8 gap-2"
          >
            <IconPencil className="size-4" />
            Edit
          </Button>
          <VideoActions video={video} {...actions} />
        </div>
      </div>
      {next.length ? (
        <div>
          <p className="mb-2 flex items-center gap-1 text-muted-foreground uppercase">
            Up next
            <IconChevronRight className="size-3" />
          </p>
          <div
            className="grid gap-4"
            style={{
              /* 192px, for the same reason as the library grid: 16:9 of 192
               * is 108, a whole number of grid steps. */
              gridTemplateColumns: "repeat(auto-fill, 192px)",
            }}
          >
            {next.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => onOpen(entry)}
                className="min-w-0 inset-ring-1 inset-ring-border bg-card text-left transition hover:inset-ring-foreground/40"
              >
                <Poster video={entry} className="aspect-video w-full" />
                <p className="truncate px-2 py-1">{entry.title}</p>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TrashView({ trash, onRestore }) {
  if (!trash.length) {
    return (
      <p className="px-3 py-10 text-muted-foreground">The trash is empty.</p>
    );
  }
  return (
    <div className="rule-t">
      {trash.map((batch) => (
        <div
          key={batch.id}
          className="flex items-center gap-3 rule-b px-3 py-2"
        >
          <IconTrash className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate">{batch.names.join(", ")}</p>
            <p className="text-muted-foreground">
              {countLabel(batch.count, "file")} / {formatDate(batch.deletedAt)}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onRestore(batch)}
            className="h-8"
          >
            Put back
          </Button>
        </div>
      ))}
    </div>
  );
}

function EmptyLibrary({ videosDir, onUpload }) {
  return (
    <div className="max-w-md px-3 py-16">
      <IconVideo className="size-8 text-muted-foreground" />
      <h2 className="mt-4">The library is empty</h2>
      <p className="mt-2 text-muted-foreground">
        Drop video files anywhere on this page, or copy them into
        {videosDir ? (
          <>
            {" "}
            <code className="text-foreground/80">{videosDir}</code>{" "}
          </>
        ) : (
          " the videos folder "
        )}
        and rescan. A picture beside a file is its poster; a <code>.srt</code>{" "}
        or <code>.vtt</code> beside it becomes its subtitles.
      </p>
      <Button type="button" size="sm" onClick={onUpload} className="mt-4 gap-2">
        <IconUpload className="size-4" />
        Upload video
      </Button>
    </div>
  );
}
