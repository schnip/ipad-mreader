// Retired: thumbnails are rendered and cached directly by ThumbnailRenderer
// (see thumbs.ts). This worker only copied an already rendered bitmap onto a
// white background, and a failed worker load left later thumbnails hanging.
// Nothing imports this module; it can be deleted.
export {};
