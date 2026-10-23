/** Nests root-relative file paths into folders: {dirs: Map(name -> node), files: [path]}. */
export function buildTree(files) {
  const top = { dirs: new Map(), files: [] };
  for (const file of files) {
    let node = top;
    for (const dir of file.split("/").slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
      node = node.dirs.get(dir);
    }
    node.files.push(file);
  }
  return top;
}
