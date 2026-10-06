import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import * as api from "./client";
import { resumeTime } from "./library";

const REPORT_EVERY_MS = 5000;
const POSTER_QUALITY = 0.72;
const POSTER_WIDTH = 640;

export function Player({
  video,
  autoPlay = true,
  onEnded,
  onPlay,
  onProgress,
  onPoster,
  className,
  style,
}) {
  const videoRef = useRef(null);
  const reportedRef = useRef({ path: null, at: 0 });
  const capturedRef = useRef(null);
  const [tracks, setTracks] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    setTracks([]);
    setError(null);
    api
      .fetchSubtitles(video.path)
      .then((body) => live && setTracks(body.tracks || []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [video.path]);

  const report = useCallback(
    (options = {}) => {
      const element = videoRef.current;
      if (!element) return;
      const time = element.currentTime;
      if (!Number.isFinite(time)) return;
      const patch = {
        time,
        duration: Number.isFinite(element.duration)
          ? element.duration
          : undefined,
        width: element.videoWidth || undefined,
        height: element.videoHeight || undefined,
        ...options.patch,
      };
      reportedRef.current = { path: video.path, at: Date.now() };
      void api.reportProgress(video.path, patch, { beacon: options.beacon });
      onProgress?.(video.path, patch);
    },
    [onProgress, video.path],
  );

  const capturePoster = useCallback(() => {
    const element = videoRef.current;
    if (!element || video.poster || capturedRef.current === video.path) return;
    if (!element.videoWidth || !element.videoHeight) return;
    capturedRef.current = video.path;
    const width = Math.min(POSTER_WIDTH, element.videoWidth);
    const height = Math.round(
      (width * element.videoHeight) / element.videoWidth,
    );
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    try {
      canvas.getContext("2d").drawImage(element, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (!blob) return;
          void api
            .uploadPoster(video.path, blob)
            .then(() => onPoster?.(video.path));
        },
        "image/jpeg",
        POSTER_QUALITY,
      );
    } catch {}
  }, [onPoster, video.path, video.poster]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return undefined;
    const onHide = () => report({ beacon: true });
    const onTime = () => {
      if (element.paused) return;
      if (Date.now() - reportedRef.current.at < REPORT_EVERY_MS) return;
      report();
    };
    element.addEventListener("timeupdate", onTime);
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      element.removeEventListener("timeupdate", onTime);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      report({ beacon: true });
    };
  }, [report]);

  return (
    <div className={cn("relative bg-black", className)} style={style}>
      <video
        ref={videoRef}
        key={video.path}
        src={video.url}
        poster={video.poster ? video.posterUrl : undefined}
        controls
        autoPlay={autoPlay}
        playsInline
        preload="metadata"
        crossOrigin="anonymous"
        className="size-full object-contain"
        onLoadedMetadata={(event) => {
          const element = event.currentTarget;
          const duration = Number.isFinite(element.duration)
            ? element.duration
            : 0;
          const resume = resumeTime(video, duration);
          if (resume > 0) element.currentTime = resume;
          report();
        }}
        onLoadedData={capturePoster}
        onSeeked={capturePoster}
        onPause={() => report()}
        onPlay={() => onPlay?.(video)}
        onEnded={() => {
          report({ patch: { watched: true, time: 0 } });
          onEnded?.(video);
        }}
        onError={() =>
          setError("This file could not be played in the browser.")
        }
      >
        {tracks.map((track, position) => (
          <track
            key={track.url}
            kind="subtitles"
            src={track.url}
            label={track.label}
            srcLang={track.language || undefined}
            default={position === 0}
          />
        ))}
      </video>
      {error ? (
        <p className="absolute inset-x-0 bottom-16 mx-auto w-fit bg-background/90 px-3 py-2 text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
