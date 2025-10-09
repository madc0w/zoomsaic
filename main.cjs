// Simple mosaic generator using Sharp.
// Reads zoomsaic/config.json and creates a mosaic of config.sourceImage using tiles from config.tilesDir.
// Optional config: outputWidth (px), tileSize (px), maxNonuniqueTiles (0 = unlimited)

const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');

// Global error handlers for better diagnostics
process.on('uncaughtException', (err) => {
	try {
		console.error('[uncaughtException]', err && err.stack ? err.stack : err);
	} catch (_) {}
	process.exit(1);
});
process.on('unhandledRejection', (reason) => {
	try {
		console.error(
			'[unhandledRejection]',
			reason && reason.stack ? reason.stack : reason
		);
	} catch (_) {}
	process.exit(1);
});

// ---- Defaults and basic helpers ----
const DEFAULT_OUTPUT_WIDTH = 1280;

function isImage(p) {
	const ext = path.extname(p).toLowerCase();
	return ['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext);
}

async function* walkImages(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			// Skip hidden/system-like folders for a bit of safety
			if (
				entry.name.startsWith('.') ||
				entry.name.toLowerCase() === 'node_modules'
			)
				continue;
			yield* walkImages(full);
		} else if (entry.isFile() && isImage(full)) {
			yield full;
		}
	}
}

async function computeAvgColor(imgPath) {
	const { data } = await sharp(imgPath)
		.removeAlpha()
		.toColourspace('srgb')
		.raw()
		.toBuffer({ resolveWithObject: true });
	let r = 0,
		g = 0,
		b = 0;
	const pixels = data.length / 3;
	for (let i = 0; i < data.length; i += 3) {
		r += data[i];
		g += data[i + 1];
		b += data[i + 2];
	}
	return {
		r: Math.round(r / pixels),
		g: Math.round(g / pixels),
		b: Math.round(b / pixels),
		path: imgPath,
	};
}

async function readConfig(explicitPath) {
	// Determine config path in this order:
	// 1) explicitPath argument
	// 2) first non-flag CLI argument from process.argv.slice(2)
	// 3) default to config.json next to this script
	const cliArgs = process.argv
		.slice(2)
		.filter((a) => !(typeof a === 'string' && a.startsWith('-')));
	const argPath = explicitPath || cliArgs[0] || null;

	// Build candidate paths to try (cwd first, then relative to script dir)
	const candidates = [];
	if (argPath) {
		candidates.push(path.resolve(process.cwd(), argPath));
		// If argPath is not absolute, also try relative to script directory
		if (!path.isAbsolute(argPath)) {
			candidates.push(path.resolve(__dirname, argPath));
		}
	}
	// Always include default fallback
	candidates.push(path.join(__dirname, 'config.json'));

	let lastErr;
	for (const p of candidates) {
		try {
			const text = await fs.readFile(p, 'utf8');
			const json = JSON.parse(text);
			return { json, absPath: p };
		} catch (e) {
			lastErr = e;
		}
	}
	// If all candidates failed, throw a helpful error listing attempted paths
	const tried = candidates.map((p) => `- ${p}`).join('\n');
	const msg = `Unable to read config file. Tried:\n${tried}`;
	const err = new Error(msg);
	err.cause = lastErr;
	throw err;
}

function distSq(a, b) {
	const dr = a.r - b.r;
	const dg = a.g - b.g;
	const db = a.b - b.b;
	return dr * dr + dg * dg + db * db;
}

// ---- Gaussian random (Box-Muller) ----
function randn() {
	// Standard normal N(0,1)
	let u = 0,
		v = 0;
	while (u === 0) {
		u = Math.random(); // avoid 0
	}
	while (v === 0) {
		v = Math.random();
	}
	return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function clamp(x, lo, hi) {
	return Math.max(lo, Math.min(hi, x));
}

function clampByte(v) {
	// Fast clamp to 0..255 for channel math
	return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

// ---- Robust atomic write helpers to avoid transient Windows file write errors ----
async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function safeWriteFileAtomic(filePath, data, retries = 3) {
	const dir = path.dirname(filePath);
	const base = path.basename(filePath);
	const tmp = path.join(
		dir,
		`.${base}.${crypto.randomBytes(6).toString('hex')}.tmp`
	);
	let lastErr;
	for (let i = 0; i < retries; i++) {
		try {
			await fs.writeFile(tmp, data);
			await fs.rename(tmp, filePath);
			return;
		} catch (e) {
			lastErr = e;
			try {
				await fs.unlink(tmp);
			} catch (_) {}
			// Small backoff before retry
			await sleep(200 * (i + 1));
		}
	}
	throw lastErr;
}

async function writeResizedPngAtomic(
	rawBuffer,
	rawWidth,
	rawHeight,
	outW,
	outH,
	outputPath
) {
	const pipeline = sharp(rawBuffer, {
		raw: { width: rawWidth, height: rawHeight, channels: 3 },
	})
		.resize(outW, outH)
		.png();
	const pngBuf = await pipeline.toBuffer();
	await safeWriteFileAtomic(outputPath, pngBuf, 4);
}

// ---- Simple 3D KD-Tree for nearest color lookup ----
function buildKdTree(points, depth = 0) {
	if (!points || points.length === 0) return null;
	const k = 3;
	const axis = depth % k;
	const key = axis === 0 ? 'r' : axis === 1 ? 'g' : 'b';
	const sorted = points.slice().sort((a, b) => a[key] - b[key]);
	const median = Math.floor(sorted.length / 2);
	return {
		point: sorted[median],
		axis,
		left: buildKdTree(sorted.slice(0, median), depth + 1),
		right: buildKdTree(sorted.slice(median + 1), depth + 1),
	};
}

function nearestInKdTree(node, target, best = { point: null, dist: Infinity }) {
	if (!node) return best;
	const { point, axis, left, right } = node;
	const d = distSq(target, point);
	if (d < best.dist) best = { point, dist: d };
	const key = axis === 0 ? 'r' : axis === 1 ? 'g' : 'b';
	const goLeft = target[key] < point[key];
	best = nearestInKdTree(goLeft ? left : right, target, best);
	const delta = target[key] - point[key];
	if (delta * delta < best.dist) {
		best = nearestInKdTree(goLeft ? right : left, target, best);
	}
	return best;
}

// KD-tree nearest neighbor with an allowance predicate (e.g., enforce usage limit)
function nearestAllowedInKdTree(
	node,
	target,
	isAllowed,
	best = { point: null, dist: Infinity }
) {
	if (!node) return best;
	const { point, axis, left, right } = node;
	const d = distSq(target, point);
	if (isAllowed(point) && d < best.dist) best = { point, dist: d };
	const key = axis === 0 ? 'r' : axis === 1 ? 'g' : 'b';
	const goLeft = target[key] < point[key];
	best = nearestAllowedInKdTree(goLeft ? left : right, target, isAllowed, best);
	const delta = target[key] - point[key];
	if (delta * delta < best.dist) {
		best = nearestAllowedInKdTree(
			goLeft ? right : left,
			target,
			isAllowed,
			best
		);
	}
	return best;
}

// Compose a frame from a fixed pattern (tile paths), using a given tileSize.
async function composeFrameFromPattern({
	pattern, // 2D array of tile metadata
	mosaicW,
	mosaicH,
	tileSize,
	outputWidth,
	outputHeight,
	outputPath,
	center = { x: 0.5, y: 0.5 },
	zoomScale = 1,
	colorAdjustStrength = 1,
	// debugDotOffsetPx = 0,
}) {
	const fullW = mosaicW * tileSize;
	const fullH = mosaicH * tileSize;

	// // Helper to draw a small filled circle (orange dot) at (cx, cy)
	// function drawDot(
	// 	buf,
	// 	w,
	// 	h,
	// 	cx,
	// 	cy,
	// 	radius = 3,
	// 	color = { r: 255, g: 128, b: 0 }
	// ) {
	// 	// Clamp/round center and draw filled circle
	// 	cx = Math.max(0, Math.min(w - 1, Math.round(cx)));
	// 	cy = Math.max(0, Math.min(h - 1, Math.round(cy)));
	// 	const r2 = radius * radius;
	// 	const xMin = Math.max(0, cx - radius);
	// 	const xMax = Math.min(w - 1, cx + radius);
	// 	const yMin = Math.max(0, cy - radius);
	// 	const yMax = Math.min(h - 1, cy + radius);
	// 	for (let y = yMin; y <= yMax; y++) {
	// 		const dy = y - cy;
	// 		const dy2 = dy * dy;
	// 		for (let x = xMin; x <= xMax; x++) {
	// 			const dx = x - cx;
	// 			if (dx * dx + dy2 <= r2) {
	// 				const off = (y * w + x) * 3;
	// 				buf[off] = color.r;
	// 				buf[off + 1] = color.g;
	// 				buf[off + 2] = color.b;
	// 			}
	// 		}
	// 	}
	// }

	// // Helper to draw a circle outline (white ring) around a point
	// function drawRing(
	// 	buf,
	// 	w,
	// 	h,
	// 	cx,
	// 	cy,
	// 	radius = 6,
	// 	thickness = 2,
	// 	color = { r: 255, g: 255, b: 255 }
	// ) {
	// 	cx = Math.max(0, Math.min(w - 1, Math.round(cx)));
	// 	cy = Math.max(0, Math.min(h - 1, Math.round(cy)));
	// 	const rOuter2 = radius * radius;
	// 	const rInner = Math.max(0, radius - Math.max(1, thickness));
	// 	const rInner2 = rInner * rInner;
	// 	const xMin = Math.max(0, cx - radius);
	// 	const xMax = Math.min(w - 1, cx + radius);
	// 	const yMin = Math.max(0, cy - radius);
	// 	const yMax = Math.min(h - 1, cy + radius);
	// 	for (let y = yMin; y <= yMax; y++) {
	// 		const dy = y - cy;
	// 		const dy2 = dy * dy;
	// 		for (let x = xMin; x <= xMax; x++) {
	// 			const dx = x - cx;
	// 			const d2 = dx * dx + dy2;
	// 			if (d2 <= rOuter2 && d2 >= rInner2) {
	// 				const off = (y * w + x) * 3;
	// 				buf[off] = color.r;
	// 				buf[off + 1] = color.g;
	// 				buf[off + 2] = color.b;
	// 			}
	// 		}
	// 	}
	// }

	// Fast path for 1px tiles: compute crop in tile-grid units and emit adjusted means
	if (tileSize === 1) {
		const cropW = Math.max(
			1,
			Math.min(mosaicW, Math.round(mosaicW / Math.max(1, zoomScale)))
		);
		const cropH = Math.max(
			1,
			Math.min(mosaicH, Math.round(mosaicH / Math.max(1, zoomScale)))
		);
		// Center the crop on the requested zoom point (no extra visual offset)
		const desiredLeft = Math.round(center.x * mosaicW - cropW / 2);
		const desiredTop = Math.round(center.y * mosaicH - cropH / 2);
		const cropLeft = Math.max(0, Math.min(mosaicW - cropW, desiredLeft));
		const cropTop = Math.max(0, Math.min(mosaicH - cropH, desiredTop));

		const pix = Buffer.alloc(cropW * cropH * 3);
		for (let y = 0; y < cropH; y++) {
			const srcRow = pattern[cropTop + y];
			for (let x = 0; x < cropW; x++) {
				const t = srcRow[cropLeft + x];
				const off = (y * cropW + x) * 3;
				const drS = Math.round(((t && t.dr) || 0) * colorAdjustStrength);
				const dgS = Math.round(((t && t.dg) || 0) * colorAdjustStrength);
				const dbS = Math.round(((t && t.db) || 0) * colorAdjustStrength);
				pix[off] = clampByte(((t && t.r) || 0) + drS);
				pix[off + 1] = clampByte(((t && t.g) || 0) + dgS);
				pix[off + 2] = clampByte(((t && t.b) || 0) + dbS);
			}
		}
		// Draw an orange debug dot near the zoom center with a constant screen-space offset for visibility
		// const cxCrop = Math.round(center.x * mosaicW) - cropLeft;
		// const cyCrop = Math.round(center.y * mosaicH) - cropTop;
		// let offX = 0,
		// 	offY = 0;
		// if (debugDotOffsetPx > 0) {
		// 	const dirX = center.x - 0.5;
		// 	const dirY = center.y - 0.5;
		// 	const len = Math.hypot(dirX, dirY) || 1;
		// 	const ux = dirX / len;
		// 	const uy = dirY / len;
		// 	const scale = (debugDotOffsetPx * cropW) / outputWidth;
		// 	offX = ux * scale;
		// 	offY = uy * scale;
		// }
		// drawDot(pix, cropW, cropH, cxCrop + offX, cyCrop + offY, 6);
		// drawRing(pix, cropW, cropH, cxCrop + offX, cyCrop + offY, 10, 3);
		// Larger blue dot at actual crop center for comparison
		// drawDot(
		// 	pix,
		// 	cropW,
		// 	cropH,
		// 	Math.round(cropW / 2),
		// 	Math.round(cropH / 2),
		// 	5,
		// 	{ r: 0, g: 180, b: 255 }
		// );
		await writeResizedPngAtomic(
			pix,
			cropW,
			cropH,
			outputWidth,
			outputHeight,
			outputPath
		);
		return;
	}

	// Compute crop window in pixel units of the composed full image
	const cropW = Math.max(
		1,
		Math.min(fullW, Math.round(fullW / Math.max(1, zoomScale)))
	);
	const cropH = Math.max(
		1,
		Math.min(fullH, Math.round(fullH / Math.max(1, zoomScale)))
	);
	// Center the crop on the requested zoom point (no extra visual offset)
	const desiredLeft = Math.round(center.x * fullW - cropW / 2);
	const desiredTop = Math.round(center.y * fullH - cropH / 2);
	const cropLeft = Math.max(0, Math.min(fullW - cropW, desiredLeft));
	const cropTop = Math.max(0, Math.min(fullH - cropH, desiredTop));

	// Allocate only the cropped output buffer
	const buffer = Buffer.alloc(cropW * cropH * 3);

	// Per-size cache for resized tile buffers
	const memCache = new Map();
	async function getTileBuf(p) {
		const key = `${p}|${tileSize}`;
		let buf = memCache.get(key);
		if (buf) return buf;
		buf = await readTileCacheBuffer(p, tileSize);
		if (!buf) {
			buf = await sharp(p)
				.resize(tileSize, tileSize)
				.removeAlpha()
				.toColourspace('srgb')
				.raw()
				.toBuffer();
			const expected = tileSize * tileSize * 3;
			if (buf.length !== expected) {
				buf = await sharp(p)
					.resize(tileSize, tileSize)
					.removeAlpha()
					.toColourspace('srgb')
					.raw()
					.toBuffer();
			}
			if (buf.length === expected) {
				writeTileCacheBuffer(p, tileSize, buf).catch(() => {});
			}
		}
		memCache.set(key, buf);
		return buf;
	}

	// Determine visible tile index ranges that intersect the crop
	const x0 = Math.floor(cropLeft / tileSize);
	const y0 = Math.floor(cropTop / tileSize);
	const x1 = Math.floor((cropLeft + cropW - 1) / tileSize);
	const y1 = Math.floor((cropTop + cropH - 1) / tileSize);
	const visX0 = Math.max(0, x0);
	const visY0 = Math.max(0, y0);
	const visX1 = Math.min(mosaicW - 1, x1);
	const visY1 = Math.min(mosaicH - 1, y1);

	const totalTiles = (visX1 - visX0 + 1) * (visY1 - visY0 + 1);
	let doneTiles = 0;

	for (let tyIndex = visY0; tyIndex <= visY1; tyIndex++) {
		const row = pattern[tyIndex];
		const rowSlice = row.slice(visX0, visX1 + 1);
		const bufs = await Promise.all(
			rowSlice.map((t) => getTileBuf(t.path || t))
		);
		for (let ix = visX0; ix <= visX1; ix++) {
			const tile = bufs[ix - visX0];
			const tMeta = row[ix];
			const drS = Math.round(((tMeta && tMeta.dr) || 0) * colorAdjustStrength);
			const dgS = Math.round(((tMeta && tMeta.dg) || 0) * colorAdjustStrength);
			const dbS = Math.round(((tMeta && tMeta.db) || 0) * colorAdjustStrength);

			// Tile bounds in full image pixels
			const tileLeft = ix * tileSize;
			const tileTop = tyIndex * tileSize;
			const interLeft = Math.max(cropLeft, tileLeft);
			const interTop = Math.max(cropTop, tileTop);
			const interRight = Math.min(cropLeft + cropW, tileLeft + tileSize);
			const interBottom = Math.min(cropTop + cropH, tileTop + tileSize);
			if (interRight <= interLeft || interBottom <= interTop) {
				doneTiles++;
				continue;
			}
			const regionW = interRight - interLeft;
			const regionH = interBottom - interTop;
			// Source offsets inside the tile buffer
			const srcX = interLeft - tileLeft;
			const srcY = interTop - tileTop;
			// Destination offsets inside the crop buffer
			const dstX = interLeft - cropLeft;
			const dstY = interTop - cropTop;

			for (let rowY = 0; rowY < regionH; rowY++) {
				const srcRowOff = ((srcY + rowY) * tileSize + srcX) * 3;
				const dstRowOff = ((dstY + rowY) * cropW + dstX) * 3;
				for (let px = 0; px < regionW; px++) {
					const s = srcRowOff + px * 3;
					const d = dstRowOff + px * 3;
					buffer[d] = clampByte(tile[s] + drS);
					buffer[d + 1] = clampByte(tile[s + 1] + dgS);
					buffer[d + 2] = clampByte(tile[s + 2] + dbS);
				}
			}
			doneTiles++;
		}
		if ((tyIndex - visY0 + 1) % 2 === 0 || tyIndex === visY1) {
			const pct = Math.round((doneTiles / totalTiles) * 100);
			process.stdout.write(`\r[compose visible t${tileSize}px] ${pct}%`);
			if (tyIndex === visY1) process.stdout.write('\n');
		}
	}

	// // Draw an orange debug dot at the zoom center in crop pixel space
	// const cxCropPx = Math.round(center.x * fullW) - cropLeft;
	// const cyCropPx = Math.round(center.y * fullH) - cropTop;
	// let offX2 = 0,
	// 	offY2 = 0;
	// if (debugDotOffsetPx > 0) {
	// 	const dirX = center.x - 0.5;
	// 	const dirY = center.y - 0.5;
	// 	const len = Math.hypot(dirX, dirY) || 1;
	// 	const ux = dirX / len;
	// 	const uy = dirY / len;
	// 	const scale = (debugDotOffsetPx * cropW) / outputWidth;
	// 	offX2 = ux * scale;
	// 	offY2 = uy * scale;
	// }
	// drawDot(buffer, cropW, cropH, cxCropPx + offX2, cyCropPx + offY2, 6);
	// drawRing(buffer, cropW, cropH, cxCropPx + offX2, cyCropPx + offY2, 10, 3);
	// // Draw a blue dot at the actual crop center for comparison
	// drawDot(
	// 	buffer,
	// 	cropW,
	// 	cropH,
	// 	Math.round(cropW / 2),
	// 	Math.round(cropH / 2),
	// 	5,
	// 	{
	// 		r: 0,
	// 		g: 180,
	// 		b: 255,
	// 	}
	// );

	await writeResizedPngAtomic(
		buffer,
		cropW,
		cropH,
		outputWidth,
		outputHeight,
		outputPath
	);
}

// Compute the tile selection pattern once for an iteration (enforces maxNonuniqueTiles)
async function computeIterationPattern({
	sourceImage,
	outputWidth,
	outputHeight,
	tiles,
	kdTree,
	maxNonuniqueTiles,
	center,
	layoutTileSize = 2, // base tile size for layout grid
}) {
	// Build the layout on a coarser grid to keep usage caps feasible and fast
	const mosaicW = Math.max(
		1,
		Math.floor(outputWidth / Math.max(1, layoutTileSize))
	);
	const mosaicH = Math.max(
		1,
		Math.floor(outputHeight / Math.max(1, layoutTileSize))
	);

	// Prepare analysis: resize the whole source to the mosaic grid, centered as requested
	const srcMeta = await sharp(sourceImage).metadata();
	const srcW = srcMeta.width,
		srcH = srcMeta.height;
	const cx = Math.round(srcW * center.x),
		cy = Math.round(srcH * center.y);
	// With scale=1 (no zoom), crop is full source but we still center if bounds allow
	const left = Math.max(0, Math.min(srcW - srcW, cx - Math.round(srcW / 2)));
	const top = Math.max(0, Math.min(srcH - srcH, cy - Math.round(srcH / 2)));
	const { data: analysis } = await sharp(sourceImage)
		.extract({ left, top, width: srcW, height: srcH })
		.resize(mosaicW, mosaicH)
		.removeAlpha()
		.toColourspace('srgb')
		.raw()
		.toBuffer({ resolveWithObject: true });

	const usage = maxNonuniqueTiles > 0 ? new Map() : null;
	const isAllowed = (t) =>
		!usage ? true : (usage.get(t.path) || 0) < maxNonuniqueTiles;
	const pattern = new Array(mosaicH);
	const t0 = Date.now();
	for (let y = 0; y < mosaicH; y++) {
		pattern[y] = new Array(mosaicW);
		for (let x = 0; x < mosaicW; x++) {
			const idx = (y * mosaicW + x) * 3;
			const color = {
				r: analysis[idx],
				g: analysis[idx + 1],
				b: analysis[idx + 2],
			};

			// Avoid adjacency with left/top neighbors
			const leftPath = x > 0 ? pattern[y][x - 1]?.path : null;
			const topPath = y > 0 ? pattern[y - 1][x]?.path : null;
			const isAllowedAdj = (t) =>
				isAllowed(t) && t.path !== leftPath && t.path !== topPath;

			let node = nearestAllowedInKdTree(kdTree, color, isAllowedAdj);
			let best = node.point;
			if (!best) {
				// Relax adjacency progressively while honoring usage cap
				const leftOnly = (t) => isAllowed(t) && t.path !== topPath;
				const topOnly = (t) => isAllowed(t) && t.path !== leftPath;
				const cand1 = nearestAllowedInKdTree(kdTree, color, leftOnly).point;
				const cand2 = nearestAllowedInKdTree(kdTree, color, topOnly).point;
				if (cand1 && cand2) {
					// Choose closer of two relaxed candidates
					best = distSq(color, cand1) <= distSq(color, cand2) ? cand1 : cand2;
				} else {
					best = cand1 || cand2;
				}
			}
			if (!best) {
				// Fall back to ignoring adjacency but keeping usage
				best = nearestAllowedInKdTree(kdTree, color, isAllowed).point;
			}
			if (!best) {
				// Final fallback: ignore all constraints
				best = nearestInKdTree(kdTree, color).point;
			}
			if (usage) {
				usage.set(best.path, (usage.get(best.path) || 0) + 1);
			}
			// Store tile choice along with per-cell color adjustment to better
			// match the source mean color at this grid cell during compositing.
			pattern[y][x] = {
				path: best.path,
				r: best.r,
				g: best.g,
				b: best.b,
				dr: (color.r | 0) - (best.r | 0),
				dg: (color.g | 0) - (best.g | 0),
				db: (color.b | 0) - (best.b | 0),
			};
		}

		{
			const pct = ((y + 1) / mosaicH) * 100;
			// const elapsed = Date.now() - t0;
			// if (!computeIterationPattern.timings) {
			// 	computeIterationPattern.timings = [];
			// }
			// const timings = computeIterationPattern.timings;

			// let projectedTotal;
			// if (timings.length >= 2) {
			// 	// Calculate average time per row from recent iterations
			// 	const recentTimings = timings.slice(-2); // Last 2 iterations
			// 	const avgTimePerRow =
			// 		recentTimings.reduce((sum, time) => sum + time, 0) /
			// 		recentTimings.length;
			// 	projectedTotal = avgTimePerRow * mosaicH;
			// } else {
			// 	// Fallback to original calculation for first few iterations
			// 	projectedTotal = elapsed * (mosaicH / (y + 1));
			// }
			// const projectedDuration = (projectedTotal - elapsed) / 60000;
			// const projectedEndDate = new Date(Date.now() + projectedTotal - elapsed);

			// // Store timing for this iteration when complete
			// if (y === mosaicH - 1) {
			// 	timings.push(elapsed / mosaicH); // time per row
			// 	while (timings.length > 2) {
			// 		timings.shift(); // Keep only last 2
			// 	}
			// }
			process.stdout.write(`\r[layout iteration] ${pct.toFixed(2)}%`);
			// process.stdout.write(
			// 	`\r[layout iteration] ${pct.toFixed(
			// 		2
			// 	)}%  projected duration: ${projectedDuration.toFixed(
			// 		1
			// 	)} minutes, projected end: ${projectedEndDate.toISOString()}`
			// );
			if (y === mosaicH - 1) {
				process.stdout.write('\n');
			}
		}
	}
	return { pattern, mosaicW, mosaicH };
}

// ---- Disk cache for resized tile buffers (.tile_cache) ----
function getTileCacheDir() {
	return path.join(__dirname, '.tile_cache');
}

async function ensureTileCacheDir() {
	const dir = getTileCacheDir();
	try {
		await fs.mkdir(dir, { recursive: true });
	} catch (_) {}
	return dir;
}

function cacheFilenameFor(tilePath, tileSize) {
	const hash = crypto
		.createHash('md5')
		.update(tilePath + '_' + tileSize)
		.digest('hex');
	return `${hash}_${tileSize}.cache`;
}

async function readTileCacheBuffer(tilePath, tileSize) {
	const dir = getTileCacheDir();
	const file = path.join(dir, cacheFilenameFor(tilePath, tileSize));
	try {
		const buf = await fs.readFile(file);
		const expected = tileSize * tileSize * 3;
		if (buf.length !== expected) {
			// corrupted; remove and signal miss
			try {
				await fs.unlink(file);
			} catch (_) {}
			return null;
		}
		return buf;
	} catch (_) {
		return null;
	}
}

async function writeTileCacheBuffer(tilePath, tileSize, buffer) {
	const dir = await ensureTileCacheDir();
	const file = path.join(dir, cacheFilenameFor(tilePath, tileSize));
	try {
		await fs.writeFile(file, buffer);
	} catch (e) {
		// Non-fatal: continue without disk cache if write fails
		// console.warn(`[tile cache] write failed: ${e.message}`);
	}
}

// Rescan tilesDir and add any missing images to tiles.csv (does not remove stale entries)
async function rescanAndAppendTileCache(tilesDir, cacheName = 'tiles.csv') {
	const cachePath = path.join(tilesDir, cacheName);
	// Load existing entries if present
	let existing = [];
	try {
		const csv = await fs.readFile(cachePath, 'utf8');
		const lines = csv.trim().split(/\r?\n/);
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			const idx1 = line.lastIndexOf(',');
			const idx2 = line.lastIndexOf(',', idx1 - 1);
			const idx3 = line.lastIndexOf(',', idx2 - 1);
			if (idx1 < 0 || idx2 < 0 || idx3 < 0) continue;
			const p = line.slice(0, idx3);
			const r = parseInt(line.slice(idx3 + 1, idx2));
			const g = parseInt(line.slice(idx2 + 1, idx1));
			const b = parseInt(line.slice(idx1 + 1));
			if (
				!Number.isNaN(r) &&
				!Number.isNaN(g) &&
				!Number.isNaN(b) &&
				isImage(p)
			) {
				existing.push({ path: p, r, g, b });
			}
		}
		console.log(`[tiles cache] loaded ${existing.length} from ${cachePath}`);
	} catch (_) {
		// no existing cache; we'll create from scratch
	}

	const existingSet = new Set(existing.map((e) => e.path));
	const newTiles = [];
	let scanned = 0;
	console.log(`[tiles] rescanning ${tilesDir} for missing images...`);
	for await (const img of walkImages(tilesDir)) {
		if (!existingSet.has(img)) {
			try {
				const avg = await computeAvgColor(img);
				newTiles.push(avg);
				if (newTiles.length % 100 === 0) {
					process.stdout.write(`\rnew tiles computed: ${newTiles.length}`);
				}
			} catch (_) {
				// skip unreadable images
			}
		}
		scanned++;
		if (scanned % 500 === 0) {
			process.stdout.write(`\rscanned ${scanned} files...`);
		}
	}
	if (newTiles.length) process.stdout.write('\n');

	if (newTiles.length === 0) {
		console.log('[tiles cache] no missing tiles found; cache up to date');
		return existing;
	}

	const all = existing.concat(newTiles);
	const outLines = [
		'path,r,g,b',
		...all.map((t) => `${t.path},${t.r},${t.g},${t.b}`),
	];
	try {
		await safeWriteFileAtomic(
			cachePath,
			Buffer.from(outLines.join('\n'), 'utf8'),
			4
		);
		console.log(
			`[tiles cache] added ${newTiles.length} new entries (total ${all.length}) -> ${cachePath}`
		);
	} catch (e) {
		console.warn(
			`[tiles cache] failed to update: ${e && e.message ? e.message : e}`
		);
	}
	return all;
}

async function loadOrBuildTileCache(tilesDir, cacheName = 'tiles.csv') {
	const cachePath = path.join(tilesDir, cacheName);
	// Try reading cache
	try {
		const csv = await fs.readFile(cachePath, 'utf8');
		const lines = csv.trim().split(/\r?\n/);
		const out = [];
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			// path,r,g,b
			const idx1 = line.lastIndexOf(',');
			const idx2 = line.lastIndexOf(',', idx1 - 1);
			const idx3 = line.lastIndexOf(',', idx2 - 1);
			if (idx1 < 0 || idx2 < 0 || idx3 < 0) continue;
			const p = line.slice(0, idx3);
			const r = parseInt(line.slice(idx3 + 1, idx2));
			const g = parseInt(line.slice(idx2 + 1, idx1));
			const b = parseInt(line.slice(idx1 + 1));
			if (
				!Number.isNaN(r) &&
				!Number.isNaN(g) &&
				!Number.isNaN(b) &&
				isImage(p)
			) {
				out.push({ path: p, r, g, b });
			}
		}
		if (out.length > 0) {
			console.log(`[tiles cache] loaded ${out.length} from ${cachePath}`);
			return out;
		}
	} catch (_) {
		// ignore; we'll build
	}

	// Build cache
	console.log(`[tiles] scanning ${tilesDir}...`);
	const tiles = [];
	let count = 0;
	for await (const img of walkImages(tilesDir)) {
		try {
			const avg = await computeAvgColor(img);
			tiles.push(avg);
			count++;
			if (count % 100 === 0) process.stdout.write(`\rprocessed ${count} tiles`);
		} catch (e) {
			// skip unreadable images
		}
	}
	if (count) process.stdout.write('\n');
	if (tiles.length === 0) throw new Error('No tile images found');

	// Save cache
	const lines = [
		'path,r,g,b',
		...tiles.map((t) => `${t.path},${t.r},${t.g},${t.b}`),
	];
	try {
		await fs.writeFile(cachePath, lines.join('\n'), 'utf8');
		console.log(`[tiles cache] saved ${tiles.length} to ${cachePath}`);
	} catch (e) {
		console.warn(`[tiles cache] failed to save: ${e.message}`);
	}
	return tiles;
}

// async function buildMosaic({
// 	sourceImage,
// 	tiles,
// 	outputWidth,
// 	tileSize,
// 	outputPath,
// 	maxNonuniqueTiles = 0,
// }) {
// 	// Analyze source
// 	const meta = await sharp(sourceImage).metadata();
// 	if (!meta.width || !meta.height)
// 		throw new Error('Could not read source image metadata');

// 	const aspect = meta.height / meta.width;
// 	const mosaicW = Math.max(1, Math.round(outputWidth / tileSize));
// 	const mosaicH = Math.max(1, Math.round(mosaicW * aspect));

// 	console.log(`[mosaic] grid ${mosaicW} x ${mosaicH} tiles (${tileSize}px)`);

// 	const { data: src } = await sharp(sourceImage)
// 		.resize(mosaicW, mosaicH)
// 		.removeAlpha()
// 		.raw()
// 		.toBuffer({ resolveWithObject: true });

// 	// Select tile per cell
// 	const usage = new Map();
// 	const chosen = new Array(mosaicH);
// 	for (let y = 0; y < mosaicH; y++) {
// 		chosen[y] = new Array(mosaicW);
// 		for (let x = 0; x < mosaicW; x++) {
// 			const idx = (y * mosaicW + x) * 3;
// 			const target = { r: src[idx], g: src[idx + 1], b: src[idx + 2] };

// 			let best = null;
// 			let bestD = Infinity;
// 			for (const t of tiles) {
// 				if (maxNonuniqueTiles > 0) {
// 					const u = usage.get(t.path) || 0;
// 					if (u >= maxNonuniqueTiles) continue;
// 				}
// 				const d = distSq(target, t);
// 				if (d < bestD) {
// 					bestD = d;
// 					best = t;
// 				}
// 			}
// 			// If all exhausted due to maxNonuniqueTiles, ignore limit
// 			if (!best) {
// 				for (const t of tiles) {
// 					const d = distSq(target, t);
// 					if (d < bestD) {
// 						bestD = d;
// 						best = t;
// 					}
// 				}
// 			}
// 			chosen[y][x] = best.path;
// 			if (maxNonuniqueTiles > 0)
// 				usage.set(best.path, (usage.get(best.path) || 0) + 1);
// 		}
// 		if ((y + 1) % 10 === 0 || y === mosaicH - 1) {
// 			const pct = Math.round(((y + 1) / mosaicH) * 100);
// 			process.stdout.write(`\r[match] ${pct}%`);
// 			if (y === mosaicH - 1) process.stdout.write('\n');
// 		}
// 	}

// 	// Compose final buffer (actual mosaic size)
// 	const actualW = mosaicW * tileSize;
// 	const actualH = mosaicH * tileSize;
// 	const buffer = Buffer.alloc(actualW * actualH * 3);

// 	// Precompute and cache resized tile buffers to avoid rework
// 	const tileBufferCache = new Map(); // key: `${path}|${tileSize}`
// 	async function getTileBuffer(p) {
// 		const key = `${p}|${tileSize}`;
// 		let buf = tileBufferCache.get(key);
// 		if (buf) return buf;
// 		// Try disk cache first
// 		buf = await readTileCacheBuffer(p, tileSize);
// 		if (!buf) {
// 			// Generate and persist
// 			buf = await sharp(p)
// 				.resize(tileSize, tileSize)
// 				.removeAlpha()
// 				.raw()
// 				.toBuffer();
// 			const expected = tileSize * tileSize * 3;
// 			if (buf.length !== expected) {
// 				// Regenerate if somehow wrong size
// 				buf = await sharp(p)
// 					.resize(tileSize, tileSize)
// 					.removeAlpha()
// 					.raw()
// 					.toBuffer();
// 			}
// 			// Best-effort save to disk cache
// 			writeTileCacheBuffer(p, tileSize, buf).catch(() => {});
// 		}
// 		tileBufferCache.set(key, buf);
// 		return buf;
// 	}

// 	for (let y = 0; y < mosaicH; y++) {
// 		// Build one row at a time
// 		const rowTilePaths = chosen[y];
// 		const rowStart = y * tileSize * actualW * 3;
// 		const rowTileBuffers = await Promise.all(
// 			rowTilePaths.map((p) => getTileBuffer(p))
// 		);
// 		for (let x = 0; x < mosaicW; x++) {
// 			const tileBuf = rowTileBuffers[x];
// 			const startX = x * tileSize;
// 			for (let ty = 0; ty < tileSize; ty++) {
// 				const srcRow = ty * tileSize * 3;
// 				const dstRow = rowStart + (ty * actualW + startX) * 3;
// 				tileBuf.copy(buffer, dstRow, srcRow, srcRow + tileSize * 3);
// 			}
// 		}
// 		if ((y + 1) % 5 === 0 || y === mosaicH - 1) {
// 			const pct = Math.round(((y + 1) / mosaicH) * 100);
// 			process.stdout.write(`\r[compose] ${pct}%`);
// 			if (y === mosaicH - 1) process.stdout.write('\n');
// 		}
// 	}

// 	// Resize to requested outputWidth and keep aspect
// 	const targetW = outputWidth;
// 	const targetH = Math.round(targetW * (actualH / actualW));
// 	await sharp(buffer, { raw: { width: actualW, height: actualH, channels: 3 } })
// 		.resize(targetW, targetH)
// 		.png()
// 		.toFile(outputPath);

// 	return { width: targetW, height: targetH, tilesUsed: mosaicW * mosaicH };
// }

function pad4(n) {
	return String(n).padStart(4, '0');
}

// Generate a single frame by re-mosaicing the zoomed crop of the source
// async function generateFrame({
// 	frameIndex, // for logging only (global running index)
// 	stepInIteration = frameIndex, // 1..zoomSteps controls tile sizing
// 	sourceImage,
// 	outputWidth,
// 	outputHeight,
// 	zoomFactor,
// 	tiles,
// 	kdTree,
// 	maxNonuniqueTiles = 0,
// 	outputPath,
// 	center = { x: 0.5, y: 0.5 },
// 	colorAdjustStrength = 1,
// }) {
// 	// tile size for this frame (reset progression per iteration)
// 	const tileSize = Math.max(
// 		1,
// 		Math.ceil(Math.pow(zoomFactor, stepInIteration - 1))
// 	);

// 	// number of tiles in the output grid
// 	const mosaicW = Math.max(1, Math.round(outputWidth / tileSize));
// 	const mosaicH = Math.max(1, Math.round(outputHeight / tileSize));

// 	// Determine crop on the original source to create the zoom effect
// 	const srcMeta = await sharp(sourceImage).metadata();
// 	const srcW = srcMeta.width,
// 		srcH = srcMeta.height;
// 	const scale = Math.max(1, Math.pow(zoomFactor, stepInIteration - 1));
// 	const cropW = Math.max(1, Math.round(srcW / scale));
// 	const cropH = Math.max(1, Math.round(srcH / scale));
// 	const cx = Math.round(srcW * center.x),
// 		cy = Math.round(srcH * center.y);
// 	const left = Math.max(0, Math.min(srcW - cropW, cx - Math.round(cropW / 2)));
// 	const top = Math.max(0, Math.min(srcH - cropH, cy - Math.round(cropH / 2)));

// 	// Get analysis image for this frame: resize the crop to the mosaic grid
// 	const { data: analysis } = await sharp(sourceImage)
// 		.extract({ left, top, width: cropW, height: cropH })
// 		.resize(mosaicW, mosaicH)
// 		.removeAlpha()
// 		.raw()
// 		.toBuffer({ resolveWithObject: true });

// 	// Select tiles per cell using KD-tree (fast)
// 	const usage = maxNonuniqueTiles > 0 ? new Map() : null;
// 	const selected = new Array(mosaicH);
// 	for (let y = 0; y < mosaicH; y++) {
// 		selected[y] = new Array(mosaicW);
// 		for (let x = 0; x < mosaicW; x++) {
// 			const idx = (y * mosaicW + x) * 3;
// 			const color = {
// 				r: analysis[idx],
// 				g: analysis[idx + 1],
// 				b: analysis[idx + 2],
// 			};

// 			// Avoid adjacency with left/top neighbors
// 			const leftPath = x > 0 ? selected[y][x - 1]?.path : null;
// 			const topPath = y > 0 ? selected[y - 1][x]?.path : null;
// 			const withinCap = (t) =>
// 				!usage ? true : (usage.get(t.path) || 0) < maxNonuniqueTiles;
// 			const isAllowedAdj = (t) =>
// 				withinCap(t) && t.path !== leftPath && t.path !== topPath;

// 			let node = nearestAllowedInKdTree(kdTree, color, isAllowedAdj);
// 			let best = node.point;
// 			if (!best) {
// 				const leftOnly = (t) => withinCap(t) && t.path !== topPath;
// 				const topOnly = (t) => withinCap(t) && t.path !== leftPath;
// 				const cand1 = nearestAllowedInKdTree(kdTree, color, leftOnly).point;
// 				const cand2 = nearestAllowedInKdTree(kdTree, color, topOnly).point;
// 				if (cand1 && cand2) {
// 					best = distSq(color, cand1) <= distSq(color, cand2) ? cand1 : cand2;
// 				} else {
// 					best = cand1 || cand2;
// 				}
// 			}
// 			if (!best) best = nearestAllowedInKdTree(kdTree, color, withinCap).point;
// 			if (!best) best = nearestInKdTree(kdTree, color).point;

// 			if (usage) usage.set(best.path, (usage.get(best.path) || 0) + 1);
// 			selected[y][x] = {
// 				path: best.path,
// 				r: best.r,
// 				g: best.g,
// 				b: best.b,
// 				dr: (color.r | 0) - (best.r | 0),
// 				dg: (color.g | 0) - (best.g | 0),
// 				db: (color.b | 0) - (best.b | 0),
// 			};
// 		}
// 		if ((y + 1) % 10 === 0 || y === mosaicH - 1) {
// 			const pct = Math.round(((y + 1) / mosaicH) * 100);
// 			process.stdout.write(
// 				`\r[selecting frame: ${frameIndex} tile size: ${tileSize}px] ${pct}%`
// 			);
// 			if (y === mosaicH - 1) process.stdout.write('\n');
// 		}
// 	}

// 	// Compose the frame
// 	if (tileSize === 1) {
// 		// Fast path: fill pixels directly with the chosen tile average colors
// 		const pix = Buffer.alloc(mosaicW * mosaicH * 3);
// 		for (let y = 0; y < mosaicH; y++) {
// 			for (let x = 0; x < mosaicW; x++) {
// 				const t = selected[y][x];
// 				const off = (y * mosaicW + x) * 3;
// 				const dr = (t && t.dr) || 0;
// 				const dg = (t && t.dg) || 0;
// 				const db = (t && t.db) || 0;
// 				const drS = Math.round(dr * colorAdjustStrength);
// 				const dgS = Math.round(dg * colorAdjustStrength);
// 				const dbS = Math.round(db * colorAdjustStrength);
// 				pix[off] = clampByte(((t && t.r) || 0) + drS);
// 				pix[off + 1] = clampByte(((t && t.g) || 0) + dgS);
// 				pix[off + 2] = clampByte(((t && t.b) || 0) + dbS);
// 			}
// 		}
// 		await writeResizedPngAtomic(
// 			pix,
// 			mosaicW,
// 			mosaicH,
// 			outputWidth,
// 			outputHeight,
// 			outputPath
// 		);
// 		return;
// 	}

// 	const actualW = mosaicW * tileSize;
// 	const actualH = mosaicH * tileSize;
// 	const frameBuf = Buffer.alloc(actualW * actualH * 3);
// 	// Per-size cache of tile buffers (and disk cache usage)
// 	const memCache = new Map();
// 	async function getTileBuf(p) {
// 		const key = `${p}|${tileSize}`;
// 		let buf = memCache.get(key);
// 		if (buf) return buf;
// 		buf = await readTileCacheBuffer(p, tileSize);
// 		if (!buf) {
// 			buf = await sharp(p)
// 				.resize(tileSize, tileSize)
// 				.removeAlpha()
// 				.raw()
// 				.toBuffer();
// 			const expected = tileSize * tileSize * 3;
// 			if (buf.length !== expected) {
// 				buf = await sharp(p)
// 					.resize(tileSize, tileSize)
// 					.removeAlpha()
// 					.raw()
// 					.toBuffer();
// 			}
// 			writeTileCacheBuffer(p, tileSize, buf).catch(() => {});
// 		}
// 		memCache.set(key, buf);
// 		return buf;
// 	}

// 	for (let y = 0; y < mosaicH; y++) {
// 		const row = selected[y];
// 		const rowStart = y * tileSize * actualW * 3;
// 		const bufs = await Promise.all(row.map((t) => getTileBuf(t.path)));
// 		for (let x = 0; x < mosaicW; x++) {
// 			const tile = bufs[x];
// 			const tMeta = row[x];
// 			const dr = (tMeta && tMeta.dr) || 0;
// 			const dg = (tMeta && tMeta.dg) || 0;
// 			const db = (tMeta && tMeta.db) || 0;
// 			const startX = x * tileSize;
// 			for (let ty = 0; ty < tileSize; ty++) {
// 				const srcRow = ty * tileSize * 3;
// 				const dstRow = rowStart + (ty * actualW + startX) * 3;
// 				for (let px = 0; px < tileSize; px++) {
// 					const s = srcRow + px * 3;
// 					const d = dstRow + px * 3;
// 					const drS = Math.round(dr * colorAdjustStrength);
// 					const dgS = Math.round(dg * colorAdjustStrength);
// 					const dbS = Math.round(db * colorAdjustStrength);
// 					frameBuf[d] = clampByte(tile[s] + drS);
// 					frameBuf[d + 1] = clampByte(tile[s + 1] + dgS);
// 					frameBuf[d + 2] = clampByte(tile[s + 2] + dbS);
// 				}
// 			}
// 		}
// 		if ((y + 1) % 5 === 0 || y === mosaicH - 1) {
// 			const pct = Math.round(((y + 1) / mosaicH) * 100);
// 			process.stdout.write(
// 				`\r[composing frame: ${frameIndex} tile size: ${tileSize}px] ${pct}%`
// 			);
// 			if (y === mosaicH - 1) process.stdout.write('\n');
// 		}
// 	}

// 	// Resize to exact output dims (minor scale/crop difference possible)
// 	await writeResizedPngAtomic(
// 		frameBuf,
// 		actualW,
// 		actualH,
// 		outputWidth,
// 		outputHeight,
// 		outputPath
// 	);
// }

async function main() {
	const { json: config, absPath } = await readConfig();
	console.log(`[config] ${absPath}`);

	const sourceImage = config.sourceImage;
	const tilesDir = config.tilesDir;
	const outputFilename = config.outputFilename || 'mosaic.png';
	const outputWidth = Number(config.outputWidth) || DEFAULT_OUTPUT_WIDTH;
	const outParsed = path.parse(path.resolve(__dirname, outputFilename));
	const outputBaseNoExt = path.join(outParsed.dir, outParsed.name);
	const maxNonuniqueTiles =
		Number(config.maxUniqueTiles ?? config.maxNonuniqueTiles ?? 0) || 0;

	if (!sourceImage || !tilesDir) {
		throw new Error('config.json must include sourceImage and tilesDir');
	}

	// Verify access early
	await fs.access(sourceImage);
	await fs.access(tilesDir);

	// Optional rescan: add any missing tiles to tiles.csv if --rescan flag is provided
	const forceRescan = process.argv.includes('--rescan');
	if (forceRescan) {
		await rescanAndAppendTileCache(tilesDir);
	}

	// Load tiles once and build KD-tree for fast nearest lookups
	const tiles = await loadOrBuildTileCache(tilesDir);
	console.log(`[tiles] ${tiles.length} available`);
	const kdTree = buildKdTree(tiles);

	// Determine final output height based on source aspect
	const meta = await sharp(sourceImage).metadata();
	const outputHeight = Math.round(outputWidth * (meta.height / meta.width));

	// Color adjustment strength (0..1)
	let colorAdjustStrength = Number(config.colorAdjustStrength);
	if (!isFinite(colorAdjustStrength)) {
		colorAdjustStrength = 1;
	}
	colorAdjustStrength = Math.max(0, Math.min(1, colorAdjustStrength));

	// Infinite iterations: each iteration renders zoomSteps frames,
	// then uses the last frame as the next iteration's source image.
	const zoomSteps = Math.max(1, Number(config.zoomSteps) || 1);
	let zf = Number(config.zoomFactor);
	if (!isFinite(zf)) {
		zf = 1.1;
	} else if (zf <= 0) {
		// Non-positive factors are invalid; use safe default
		zf = 1.1;
	} else if (zf <= 1) {
		// Treat 0 < zoomFactor <= 1 as a percentage (e.g., 0.08 => 1.08)
		zf = 1 + zf;
	}

	const center = { x: 0.5, y: 0.5 };
	// Track previous and last centers so we can roll back on failures
	let prevCenter = { x: center.x, y: center.y };
	let lastCenter = { x: center.x, y: center.y };
	const zoomMotion = Number(config.randomZoomMotion) || 0;
	const zoomMotionRadius = Number(config.zoomMotionRadius) || 0;
	const zoomMotionRadiansPerFrame =
		Number(config.zoomMotionRadiansPerFrame) || 0;

	let orbitAngle = 0;

	// Keep small random-walk jitter separate from orbital base
	let jitterX = 0;
	let jitterY = 0;

	let globalFrame = 1;
	let currentSource = sourceImage;
	let iteration = 1;
	while (true) {
		console.log(
			`[iteration ${iteration}] ${new Date().toISOString()} : start; source: ${currentSource}`
		);
		// Compute pattern once at the start of the iteration (enforce maxNonuniqueTiles)
		const layout = await computeIterationPattern({
			sourceImage: currentSource,
			outputWidth,
			outputHeight,
			tiles,
			kdTree,
			maxNonuniqueTiles,
			center,
		});
		if (currentSource !== sourceImage) {
			// Remove previous iteration's temp source image
			try {
				await fs.unlink(currentSource);
			} catch (e) {
				// If cleanup fails, roll back the zoom center to the previous value
				console.warn(
					`[cleanup] failed to delete ${currentSource}: ${
						e && e.message ? e.message : e
					}. Rolling back zoom center.`
				);
				center.x = prevCenter.x;
				center.y = prevCenter.y;
				lastCenter = { x: center.x, y: center.y };
			}
		}

		// Track the last actually generated frame this iteration
		let lastFramePath = null;
		for (let step = 1; step <= zoomSteps; step++) {
			const framePath = `${outputBaseNoExt}_${pad4(globalFrame)}.png`;
			console.log(
				`[frame ${globalFrame} (iter ${iteration}, step ${step}/${zoomSteps})] -> ${framePath}`
			);
			const t0 = Date.now();
			// Make motion absolute w.r.t. output by scaling by inverse zoom
			const stepScale = Math.max(1, Math.pow(zf, step - 1));

			// Update orbital center around (0.5, 0.5)
			if (zoomMotionRadius > 0 && zoomMotionRadiansPerFrame !== 0) {
				// Advance angle each frame
				orbitAngle += zoomMotionRadiansPerFrame;
			}
			// Keep orbit radius constant in screen pixels across zoom steps.
			// Interpret >1 as pixels; else as fraction of output width. Divide by stepScale to compensate zoom.
			const rawOrbitNorm =
				zoomMotionRadius > 1
					? zoomMotionRadius / outputWidth
					: zoomMotionRadius;
			let orbitRadiusNorm = rawOrbitNorm / stepScale;
			// Avoid hitting crop bounds: max normalized radius that keeps the crop inside the image
			const maxNorm = Math.max(0, 0.5 - 0.5 / stepScale);
			if (orbitRadiusNorm > maxNorm) orbitRadiusNorm = maxNorm;
			const baseX = 0.5 + orbitRadiusNorm * Math.cos(orbitAngle);
			const baseY = 0.5 + orbitRadiusNorm * Math.sin(orbitAngle);

			// Add optional small random-walk jitter around the orbital center
			let jitterDX = 0,
				jitterDY = 0;
			if (zoomMotion > 0 && globalFrame > 1) {
				// Keep jitter amplitude constant in screen space by scaling with 1/stepScale
				const jitterNorm =
					(zoomMotion > 1 ? zoomMotion / outputWidth : zoomMotion) / stepScale;
				jitterDX = randn() * jitterNorm;
				jitterDY = randn() * jitterNorm;
			}
			// Snapshot current center before updating so we can roll back if needed
			prevCenter = { x: center.x, y: center.y };
			// Allow full range; cropping logic will clamp within image bounds
			center.x = clamp(baseX + jitterDX, 0, 1);
			center.y = clamp(baseY + jitterDY, 0, 1);
			lastCenter = { x: center.x, y: center.y };
			const tileSize = Math.max(1, Math.ceil(Math.pow(zf, step - 1)));
			const zoomScale = Math.max(1, Math.pow(zf, step - 1));
			await composeFrameFromPattern({
				pattern: layout.pattern,
				mosaicW: layout.mosaicW,
				mosaicH: layout.mosaicH,
				tileSize,
				outputWidth,
				outputHeight,
				outputPath: framePath,
				center,
				zoomScale,
				colorAdjustStrength,
				// Draw the orange debug dot slightly offset from the exact center in the orbit direction,
				// with a constant on-screen radius for visibility.
				// debugDotOffsetPx: 20,
			});
			const secs = Math.round((Date.now() - t0) / 1000);
			console.log(`[frame ${globalFrame}] done in ${secs}s`);
			lastFramePath = framePath;
			globalFrame++;
		}
		// Carry the last generated frame forward as the next iteration's source image
		if (lastFramePath) {
			currentSource = lastFramePath;
		}
		iteration++;
	}
}

if (require.main === module) {
	main().catch((err) => {
		console.error('[error]', err && err.stack ? err.stack : err);
		process.exit(1);
	});
}
