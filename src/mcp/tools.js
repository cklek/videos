import commands from "../cli/commands.js";

const path = {
  type: "string",
  description:
    "Video path relative to the videos folder, exactly as videos_library_list returns it (forward slashes, no dot segments).",
};
const paths = {
  type: "array",
  items: { type: "string" },
  description: "Video paths, as returned by videos_library_list.",
};
const output = {
  type: "string",
  description:
    "Save the bytes to this local file path (on the machine running the app) instead of returning them.",
};
const tags = {
  type: ["array", "string"],
  items: { type: "string" },
  description:
    "Tags as a list or comma-separated string. An empty list clears them.",
};

export default {
  ...commands,
  title: "Videos",
  instructions: `
Tools for the videos app: a video library that is a folder of files on disk,
with posters, sidecar subtitles, watch progress, favorites, titles, tags and
collections kept beside it. Paths are always relative to the videos folder and
come from videos_library_list; uploads are filed under YYYY/YYYY-MM-DD, so use
the path the upload returns. Video files are large: videos_file_get answers
with a link unless output names a file to save to. Trashing is reversible with
the batchId it returns until videos_trash_empty runs.`,
  tools: {
    "library list": {
      title: "List library",
      description:
        "Every video with its metadata and progress, favorites, the collections, and the trash batches.",
      inputSchema: {
        type: "object",
        properties: {
          rescan: { type: "boolean", description: "Walk the folder first." },
        },
      },
    },
    rescan: {
      title: "Rescan folder",
      description:
        "Walk the videos folder again, picking up files added outside the app. force re-probes every file.",
      inputSchema: {
        type: "object",
        properties: {
          force: {
            type: "boolean",
            description: "Re-probe every file, not only the changed ones.",
          },
        },
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    "file get": {
      title: "Get video bytes",
      description:
        "The video file. Answers with a link to the API (videos are too large to inline); output saves the file locally instead.",
      inputSchema: { type: "object", properties: { path, output } },
      download: true,
    },
    "poster get": {
      title: "Get poster",
      description:
        "The poster image: a sidecar image, a captured frame, or a generated SVG placeholder. Images come back inline; output saves the file locally instead.",
      inputSchema: { type: "object", properties: { path, output } },
      download: true,
    },
    upload: {
      title: "Upload videos",
      description:
        "Add video files from the local disk (paths on the machine running the app). Returns the library paths under uploaded and any refused files under rejected.",
      inputSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "Local file paths of videos to add.",
          },
        },
        required: ["files"],
      },
      annotations: { destructiveHint: false },
    },
    "video update": {
      title: "Update video",
      description:
        "Set a video's title, description or tags. Passing an empty value clears that field; reset clears all three.",
      inputSchema: {
        type: "object",
        properties: {
          path,
          title: { type: "string", description: "Up to 200 characters." },
          description: {
            type: "string",
            description: "Up to 2000 characters.",
          },
          tags,
          reset: { type: "boolean", description: "Clear every override." },
        },
        required: ["path"],
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    "video trash": {
      title: "Trash videos",
      description:
        "Move videos to the trash as one batch. Returns the batchId that videos_trash_restore takes.",
      inputSchema: {
        type: "object",
        properties: { paths },
        required: ["paths"],
      },
      query: { paths: "path" },
      annotations: { destructiveHint: false },
    },
    "favorite set": {
      title: "Set favorite",
      description: "Mark or unmark a video as a favorite.",
      inputSchema: {
        type: "object",
        properties: {
          path,
          favorite: {
            type: "boolean",
            description: "Defaults to true; false removes the favorite.",
          },
        },
        required: ["path"],
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    "collections create": {
      title: "Create collection",
      description: "Create a collection, optionally with videos in it.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Collection name." },
          paths,
        },
        required: ["name"],
      },
      annotations: { destructiveHint: false },
    },
    "collections update": {
      title: "Update collection",
      description:
        "Rename a collection, replace its videos with paths, or change them with add and remove.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "integer", description: "Collection id." },
          name: { type: "string" },
          paths: { ...paths, description: "Replace the collection's videos." },
          add: { ...paths, description: "Videos to add." },
          remove: { ...paths, description: "Videos to remove." },
        },
        required: ["id"],
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    "collections delete": {
      title: "Delete collection",
      description: "Delete a collection. The videos stay in the library.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "integer", description: "Collection id." } },
        required: ["id"],
      },
    },
    "trash restore": {
      title: "Restore from trash",
      description: "Put a trashed batch back where it came from.",
      inputSchema: {
        type: "object",
        properties: {
          batchId: {
            type: "string",
            description:
              "The batchId from videos_video_trash or the library's trash list.",
          },
        },
        required: ["batchId"],
      },
      annotations: { destructiveHint: false },
    },
    "trash empty": {
      title: "Empty trash",
      description:
        "Permanently delete everything in the trash. Cannot be undone.",
      inputSchema: { type: "object", properties: {} },
    },
    "poster save": {
      title: "Save poster",
      description:
        "Keep a JPEG from the local disk as the video's poster (what the page does with a captured frame).",
      inputSchema: {
        type: "object",
        properties: {
          path,
          file: {
            type: "string",
            description:
              "Local path of a JPEG file on the machine running the app.",
          },
        },
        required: ["path", "file"],
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    "subtitles list": {
      title: "List subtitles",
      description:
        "The subtitle files (.srt or .vtt) sitting beside a video, with their language labels and API URLs.",
      inputSchema: { type: "object", properties: { path }, required: ["path"] },
    },
    "subtitle get": {
      title: "Get subtitle text",
      description:
        "One subtitle file as WebVTT text. path is the subtitle file's path (from videos_subtitles_list), not the video's.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Subtitle file path relative to the videos folder, e.g. 2026/2026-09-06/clip.en.srt.",
          },
          output,
        },
        required: ["path"],
      },
      download: true,
    },
    "progress set": {
      title: "Save progress",
      description:
        "Record where playback got to. A time near the end marks the video watched and rewinds it; watched can be set explicitly.",
      inputSchema: {
        type: "object",
        properties: {
          path,
          time: { type: "number", description: "Seconds into the video." },
          duration: { type: "number", description: "Total seconds, if known." },
          width: { type: "integer", description: "Frame width, if known." },
          height: { type: "integer", description: "Frame height, if known." },
          watched: {
            type: "boolean",
            description: "Set the watched flag directly.",
          },
        },
        required: ["path"],
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
  },
};
