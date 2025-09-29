// Usage:
// # Infinite zoom sequence (runs forever)
// node main.cjs photo.jpg ./tiles zoom_sequence.png --infinite-zoom

// # Limited iterations
// node main.cjs photo.jpg ./tiles zoom.png --infinite-zoom --max-iterations 10

// # Custom zoom factor (20% zoom per iteration)
// node main.cjs photo.jpg ./tiles zoom.png --infinite-zoom --zoom-factor 0.8

// # Single mosaic (original behavior)
// node main.cjs photo.jpg ./tiles output.png

const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');
// const Jimp = require('jimp');

const defaultTileSize = 4;
const defaultOutputWidth = 1024; // Default output image width in pixels
const defaultZoomSteps = 40;
const defaultZoomFactor = 0.88;

const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];

class MosaicGenerator {
	constructor() {
		this.tileCache = new Map();
		this.tileSize = defaultTileSize; // Size of each mosaic tile
		this.corruptedTiles = new Set(); // Track corrupted tiles to avoid reusing them
		this.tileBufferCache = new Map(); // Map<tilePath_size, Buffer>
		this.diskCacheDir = null; // Will be set when generating mosaic
		this.writeQueue = []; // Queue for pending disk writes
		this.activeWrites = 0; // Track active write operations
		this.maxConcurrentWrites = 5; // Conservative limit to prevent file handle exhaustion
		// Cache statistics
		this.cacheStats = {
			memoryHits: 0,
			diskHits: 0,
			cacheMisses: 0,
			totalRequests: 0,
		};
	}

	// Initialize disk cache directory
	async initializeDiskCache(tilesDirectory) {
		// this.diskCacheDir = path.join(tilesDirectory, '.tile_cache');
		this.diskCacheDir = '.tile_cache';
		try {
			await fs.mkdir(this.diskCacheDir, { recursive: true });
			console.log('Disk cache initialized: ' + this.diskCacheDir);
		} catch (error) {
			console.warn(`Could not create disk cache directory: ${error.message}`);
			this.diskCacheDir = null;
		}
	}

	// Generate disk cache filename for a tile
	getDiskCacheFilename(tilePath, tileSize) {
		if (!this.diskCacheDir) return null;

		// Create a safe filename from the tile path and size
		const hash = crypto
			.createHash('md5')
			.update(tilePath + '_' + tileSize)
			.digest('hex');
		return path.join(this.diskCacheDir, `${hash}_${tileSize}.cache`);
	}

	// Load tile buffer from disk cache
	async loadTileBufferFromDisk(tilePath, tileSize) {
		const cacheFilename = this.getDiskCacheFilename(tilePath, tileSize);
		if (!cacheFilename) return null;

		try {
			const buffer = await fs.readFile(cacheFilename);
			return buffer;
		} catch (error) {
			// Cache miss or error reading cache file
			return null;
		}
	}

	// Queue tile buffer for disk write (non-blocking)
	queueTileBufferForDisk(tilePath, tileSize, buffer) {
		const cacheFilename = this.getDiskCacheFilename(tilePath, tileSize);
		if (!cacheFilename) return;

		// Add to write queue
		this.writeQueue.push({ cacheFilename, buffer });

		// Process queue if not at capacity
		this.processWriteQueue();
	}

	// Process the write queue with concurrency control
	async processWriteQueue() {
		// Don't start new writes if at capacity or queue is empty
		if (
			this.activeWrites >= this.maxConcurrentWrites ||
			this.writeQueue.length === 0
		) {
			return;
		}

		const writeTask = this.writeQueue.shift();
		if (!writeTask) return;

		this.activeWrites++;

		try {
			await fs.writeFile(writeTask.cacheFilename, writeTask.buffer);
		} catch (error) {
			// Only log EMFILE errors differently to reduce noise
			if (error.code === 'EMFILE') {
				this.maxConcurrentWrites = Math.max(2, this.maxConcurrentWrites - 2);
				console.warn(
					`Too many open files - reduced concurrent writes to ${this.maxConcurrentWrites}`
				);
			} else {
				console.warn(`Could not save tile buffer to disk: ${error.message}`);
			}
		} finally {
			this.activeWrites--;
			// Process next item in queue
			setImmediate(() => this.processWriteQueue());
		}
	}

	// Wait for all pending disk writes to complete
	async flushDiskWrites() {
		while (this.writeQueue.length > 0 || this.activeWrites > 0) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	// // Clean up old cache files (optional - call periodically)
	// async cleanupDiskCache(maxAgeHours = 24) {
	// 	if (!this.diskCacheDir) return;

	// 	try {
	// 		const files = await fs.readdir(this.diskCacheDir);
	// 		const cutoffTime = Date.now() - maxAgeHours * 60 * 60 * 1000;
	// 		let cleanedCount = 0;

	// 		for (const file of files) {
	// 			if (!file.endsWith('.cache')) continue;

	// 			const filePath = path.join(this.diskCacheDir, file);
	// 			try {
	// 				const stats = await fs.stat(filePath);
	// 				if (stats.mtime.getTime() < cutoffTime) {
	// 					await fs.unlink(filePath);
	// 					cleanedCount++;
	// 				}
	// 			} catch (error) {
	// 				// Ignore errors for individual files
	// 			}
	// 		}

	// 		if (cleanedCount > 0) {
	// 			console.log(`Cleaned up ${cleanedCount} old cache files`);
	// 		}
	// 	} catch (error) {
	// 		console.warn(`Could not clean disk cache: ${error.message}`);
	// 	}
	// }

	// Get all image files from directory and subdirectories
	async getImageFiles(dir) {
		const files = [];

		async function scanDirectory(currentDir) {
			try {
				const items = await fs.readdir(currentDir);

				for (const item of items) {
					const fullPath = path.join(currentDir, item);

					try {
						const stat = await fs.stat(fullPath);
						if (stat.isDirectory()) {
							await scanDirectory(fullPath);
						} else if (stat.isFile() && isImage(item)) {
							// Additional validation: check if file is accessible
							try {
								await fs.access(fullPath, fs.constants.R_OK);
								files.push(fullPath);
							} catch (accessError) {
								console.warn(`Skipping inaccessible file: ${fullPath}`);
							}
						}
					} catch (statError) {
						console.warn(`Could not stat ${fullPath}: ${statError.message}`);
					}
				}
			} catch (error) {
				console.warn(
					`Warning: Could not read directory ${currentDir}: ${error.message}`
				);
			}
		}

		await scanDirectory(dir);
		return files;
	}

	// Calculate average color of an image
	async getAverageColor(imagePath) {
		// Check if this tile is already known to be corrupted
		if (this.corruptedTiles.has(imagePath)) {
			return null;
		}

		if (this.tileCache.has(imagePath)) {
			return this.tileCache.get(imagePath);
		}

		try {
			// Add timeout and retry logic for network files
			const processImage = async (retryCount = 0) => {
				try {
					// Resize image to tile size and get raw pixel data
					const { data, info } = await sharp(imagePath)
						.resize(this.tileSize, this.tileSize)
						.raw()
						.toBuffer({ resolveWithObject: true });

					let r = 0,
						g = 0,
						b = 0;
					const pixelCount = data.length / 3;

					// Calculate average RGB values
					for (let i = 0; i < data.length; i += 3) {
						r += data[i];
						g += data[i + 1];
						b += data[i + 2];
					}

					const avgColor = {
						r: Math.round(r / pixelCount),
						g: Math.round(g / pixelCount),
						b: Math.round(b / pixelCount),
						path: imagePath,
					};

					this.tileCache.set(imagePath, avgColor);
					return avgColor;
				} catch (error) {
					if (
						retryCount < 2 &&
						(error.message.includes('Premature end') ||
							error.message.includes('truncated'))
					) {
						console.warn(
							`Retrying corrupted file (attempt ${
								retryCount + 2
							}/3): ${imagePath}`
						);
						await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second before retry
						return processImage(retryCount + 1);
					}
					throw error;
				}
			};

			return await processImage();
		} catch (error) {
			console.warn(
				`Warning: Could not process image ${imagePath}: ${error.message}`
			);
			// Mark this tile as corrupted during initial processing
			this.corruptedTiles.add(imagePath);
			console.warn(
				`Added ${imagePath} to corrupted tiles blacklist during preprocessing`
			);
			return null;
		}
	}

	// Validate a tile with retries for network resilience
	async validateTileWithRetry(imagePath, maxRetries = 3) {
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				await sharp(imagePath)
					.resize(this.tileSize, this.tileSize)
					.raw()
					.toBuffer();
				return; // Success
			} catch (error) {
				if (attempt === maxRetries) {
					throw error; // Final attempt failed
				}
				console.warn(
					`Validation attempt ${attempt}/${maxRetries} failed for ${imagePath}, retrying...`
				);
				// Wait before retry (exponential backoff)
				await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
			}
		}
	}

	// Calculate color distance between two colors
	colorDistanceSq(color1, color2) {
		const dr = color1.r - color2.r;
		const dg = color1.g - color2.g;
		const db = color1.b - color2.b;
		return dr * dr + dg * dg + db * db;
	}

	// Enhanced tile buffer caching with batch loading
	async preCacheTileBuffers(tileImages, tileSize) {
		// Get unique tile paths from the mosaic pattern
		const uniqueTilePaths = new Set();
		for (const row of tileImages) {
			for (const tilePath of row) {
				uniqueTilePaths.add(tilePath);
			}
		}

		const uniqueTiles = Array.from(uniqueTilePaths);
		console.log(
			`Pre-caching ${uniqueTiles.length} unique tiles at ${tileSize}px...`
		);

		// Increased batch size for better performance
		const BATCH_SIZE = 100;
		let processed = 0;

		for (let i = 0; i < uniqueTiles.length; i += BATCH_SIZE) {
			const batch = uniqueTiles.slice(i, i + BATCH_SIZE);

			// Process batch in parallel with higher concurrency
			const promises = batch.map(async (tilePath) => {
				await this.getCachedTileBuffer(tilePath, tileSize);
				processed++;
			});

			await Promise.all(promises);

			// Less frequent progress updates
			if (processed % 200 === 0 || processed === uniqueTiles.length) {
				process.stdout.write(
					`\rPre-cached ${processed}/${uniqueTiles.length} tiles`
				);
			}
		}

		console.log(''); // New line
		console.log('Pre-caching completed');
	}

	// Get cached tile buffer with on-demand loading and disk caching
	async getCachedTileBuffer(tilePath, tileSize) {
		const cacheKey = tilePath + `_${tileSize}`;
		this.cacheStats.totalRequests++;

		// Return cached buffer if available in memory
		if (this.tileBufferCache.has(cacheKey)) {
			this.cacheStats.memoryHits++;
			return this.tileBufferCache.get(cacheKey);
		}

		// Skip if already known to be corrupted
		if (this.corruptedTiles.has(tilePath)) {
			return null;
		}

		// Try to load from disk cache first
		let buffer = await this.loadTileBufferFromDisk(tilePath, tileSize);

		if (buffer) {
			// Cache hit - store in memory and return
			this.cacheStats.diskHits++;
			this.tileBufferCache.set(cacheKey, buffer);
			return buffer;
		}

		// Cache miss - load and cache the tile buffer on-demand
		this.cacheStats.cacheMisses++;
		try {
			buffer = await sharp(tilePath)
				.resize(tileSize, tileSize)
				.raw()
				.toBuffer();

			// Store in memory cache immediately
			this.tileBufferCache.set(cacheKey, buffer);

			// Queue for disk write (non-blocking)
			this.queueTileBufferForDisk(tilePath, tileSize, buffer);

			return buffer;
		} catch (error) {
			console.warn(`Failed to load tile: ${tilePath} - ${error.message}`);
			this.corruptedTiles.add(tilePath);
			return null;
		}
	}

	// Check how many tiles are cached on disk for a given size
	async checkDiskCacheSize(tileSize) {
		if (!this.diskCacheDir) return 0;

		try {
			const files = await fs.readdir(this.diskCacheDir);
			const cacheFiles = files.filter((file) =>
				file.endsWith(`_${tileSize}.cache`)
			);
			return cacheFiles.length;
		} catch (error) {
			return 0;
		}
	}

	// Print cache statistics
	async printCacheStats(tileSize) {
		const stats = this.cacheStats;
		const hitRate =
			stats.totalRequests > 0
				? (
						((stats.memoryHits + stats.diskHits) / stats.totalRequests) *
						100
				  ).toFixed(1)
				: '0.0';
		const diskCacheCount = await this.checkDiskCacheSize(tileSize);

		console.log(`Cache stats for ${tileSize}px tiles:`);
		console.log(`  Memory hits: ${stats.memoryHits}`);
		console.log(`  Disk hits: ${stats.diskHits}`);
		console.log(`  Cache misses: ${stats.cacheMisses}`);
		console.log(`  Total requests: ${stats.totalRequests}`);
		console.log(`  Hit rate: ${hitRate}%`);
		console.log(`  Disk cache files: ${diskCacheCount}`);
	} // Find the best matching tile for a given color
	findBestTile(targetColor, tiles) {
		// Filter out corrupted tiles upfront
		const validTiles = tiles.filter(
			(tile) => !this.corruptedTiles.has(tile.path)
		);

		// If no valid tiles remain, throw an error
		if (validTiles.length === 0) {
			throw new Error('No valid tiles available - all tiles are corrupted');
		}

		let bestTile = validTiles[0];
		let bestDistance = this.colorDistanceSq(targetColor, bestTile);

		for (let i = 1; i < validTiles.length; i++) {
			const distance = this.colorDistanceSq(targetColor, validTiles[i]);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestTile = validTiles[i];
			}
		}

		return bestTile;
	}

	// Load tile cache from CSV file
	async loadTileCacheFromCSV(cacheFilePath) {
		try {
			const csvData = await fs.readFile(cacheFilePath, 'utf-8');
			const lines = csvData.trim().split('\n');
			const tiles = [];

			// Skip header line
			for (let i = 1; i < lines.length; i++) {
				const [all, filePath, r, g, b] = lines[i].match(
					/(.*)\,(\d+)\,(\d+)\,(\d+)$/
				);
				if (isImage(filePath) && r && g && b) {
					const tileData = {
						path: filePath.trim(),
						r: parseInt(r.trim()),
						g: parseInt(g.trim()),
						b: parseInt(b.trim()),
					};
					tiles.push(tileData);
					this.tileCache.set(tileData.path, tileData);
				} else {
					console.log(`excluding ${filePath}`);
				}
			}

			return tiles;
		} catch (error) {
			console.error(error);
			// Cache file doesn't exist or is invalid
			return null;
		}
	}

	// Save tile cache to CSV file
	async saveTileCacheToCSV(tiles, cacheFilePath) {
		try {
			const csvLines = ['path,r,g,b'];
			for (const tile of tiles) {
				csvLines.push(`${tile.path},${tile.r},${tile.g},${tile.b}`);
			}
			await fs.writeFile(cacheFilePath, csvLines.join('\n'), 'utf-8');
			console.log(`Tile cache saved to ${cacheFilePath}`);
		} catch (error) {
			console.warn(`Warning: Could not save cache file: ${error.message}`);
		}
	}

	// Zoom into specified point of image by specified percentage
	async zoomImage(
		imagePath,
		zoomFactor = defaultZoomFactor,
		zoomPointX = 0.5,
		zoomPointY = 0.5
	) {
		const image = sharp(imagePath);
		const metadata = await image.metadata();

		const { width, height } = metadata;
		const newWidth = Math.round(width * zoomFactor);
		const newHeight = Math.round(height * zoomFactor);

		// Calculate crop coordinates based on zoom point
		// zoomPointX/Y: 0.0 = left/top edge, 0.5 = center, 1.0 = right/bottom edge
		const targetX = Math.round(width * zoomPointX);
		const targetY = Math.round(height * zoomPointY);
		const left = Math.max(
			0,
			Math.min(width - newWidth, targetX - Math.round(newWidth / 2))
		);
		const top = Math.max(
			0,
			Math.min(height - newHeight, targetY - Math.round(newHeight / 2))
		);

		// Create a temporary file for the zoomed image
		const tempPath = imagePath.replace(/(\.[^.]+)$/, '_zoomed$1');

		await image
			.extract({ left, top, width: newWidth, height: newHeight })
			.resize(width, height) // Scale back to original dimensions
			.toFile(tempPath);

		return tempPath;
	}

	// Generate infinite zoom mosaic sequence
	async generateInfiniteZoomMosaic(
		inputImagePath,
		tilesDirectory,
		outputPath,
		options = {}
	) {
		const {
			zoomFactor = defaultZoomFactor, // 10% zoom each iteration
			maxIterations = null, // null for infinite
			zoomSteps = defaultZoomSteps, // Number of zoom steps between mosaics
			zoomPointX = 0.5, // X position as fraction (0.0 = left, 1.0 = right)
			zoomPointY = 0.5, // Y position as fraction (0.0 = top, 1.0 = bottom)
			randomZoomMotion = 0, // Random motion amount
			...mosaicOptions
		} = options;

		// Parse output path to get base name and extension
		const parsedPath = path.parse(outputPath);
		const baseOutputPath = path.join(parsedPath.dir, parsedPath.name);
		const extension = parsedPath.ext;

		let currentInputPath = inputImagePath;
		let globalFrameNumber = 0;

		try {
			while (
				maxIterations === null ||
				globalFrameNumber / (zoomSteps + 1) < maxIterations
			) {
				const iterationNumber =
					Math.floor(globalFrameNumber / (zoomSteps + 1)) + 1;
				console.log(`\n=== ITERATION ${iterationNumber} ===`);

				// Check if all frames in this iteration already exist
				let allFramesExist = true;
				const iterationStartFrame = globalFrameNumber + 1;
				const iterationEndFrame = iterationStartFrame + zoomSteps;

				console.log(
					`Checking frames ${iterationStartFrame} to ${iterationEndFrame} for iteration ${iterationNumber}`
				);

				for (
					let checkFrame = iterationStartFrame;
					checkFrame <= iterationEndFrame;
					checkFrame++
				) {
					const paddedCheckFrame = checkFrame.toString().padStart(4, '0');
					const checkPath = `${baseOutputPath}_${paddedCheckFrame}${extension}`;

					try {
						await fs.access(checkPath);
						console.log(`Found existing file: ${checkPath}`);
					} catch (error) {
						// File doesn't exist
						console.log(`Missing file: ${checkPath} - will need to generate`);
						allFramesExist = false;
						break;
					}
				}

				// If all frames in this iteration exist, skip to next iteration
				if (allFramesExist) {
					console.log(
						`All frames for iteration ${iterationNumber} exist, skipping to next iteration`
					);
					globalFrameNumber = iterationEndFrame;
					currentInputPath = `${baseOutputPath}_${globalFrameNumber
						.toString()
						.padStart(4, '0')}${extension}`;
					continue;
				}

				console.log(`Not all frames exist, proceeding with generation`);

				// Apply random zoom motion if enabled
				let currentZoomPointX = zoomPointX;
				let currentZoomPointY = zoomPointY;

				if (randomZoomMotion > 0) {
					// Generate Gaussian random motion
					const motionX = gaussianRandom(0, randomZoomMotion);
					const motionY = gaussianRandom(0, randomZoomMotion);

					// Apply motion and clamp to valid range
					currentZoomPointX = Math.max(
						0.0,
						Math.min(1.0, zoomPointX + motionX)
					);
					currentZoomPointY = Math.max(
						0.0,
						Math.min(1.0, zoomPointY + motionY)
					);

					console.log(
						`Random zoom motion: (${motionX.toFixed(3)}, ${motionY.toFixed(
							3
						)}) -> (${currentZoomPointX.toFixed(
							3
						)}, ${currentZoomPointY.toFixed(3)})`
					);
				}

				// Generate mosaic first and capture tile pattern
				globalFrameNumber++;
				const paddedFrameNumber = globalFrameNumber.toString().padStart(4, '0');
				const mosaicOutputPath = `${baseOutputPath}_${paddedFrameNumber}${extension}`;

				// Check if file already exists
				let mosaicResult;
				try {
					await fs.access(mosaicOutputPath);
					console.log(`Skipping existing file: ${mosaicOutputPath}`);

					// If file exists, we need to generate the tile pattern without saving the image
					// We'll call generateMosaic with a special flag to skip file writing
					const tempOptions = { ...mosaicOptions, skipFileWrite: true };
					mosaicResult = await this.generateMosaicWithTilePattern(
						currentInputPath,
						tilesDirectory,
						null, // No output path since we're skipping file write
						tempOptions
					);
				} catch (error) {
					// File doesn't exist, generate it
					console.log(
						`Generating initial mosaic frame ${globalFrameNumber}...`
					);
					mosaicResult = await this.generateMosaicWithTilePattern(
						currentInputPath,
						tilesDirectory,
						mosaicOutputPath,
						mosaicOptions
					);
				}

				console.log(`Mosaic completed: ${mosaicOutputPath}`);

				let prevZoomTileSize;
				// Now generate zoom sequence by reusing tile pattern with larger tile sizes
				for (let zoomStep = 1; zoomStep <= zoomSteps; zoomStep++) {
					globalFrameNumber++;
					const paddedZoomFrame = globalFrameNumber.toString().padStart(4, '0');
					const zoomOutputPath = `${baseOutputPath}_${paddedZoomFrame}${extension}`;

					// Check if zoomed frame already exists
					try {
						await fs.access(zoomOutputPath);
						console.log(`Skipping existing zoomed frame: ${zoomOutputPath}`);
						continue;
					} catch (error) {
						// File doesn't exist, generate it
					}

					console.log(
						`Creating zoomed mosaic ${zoomStep}/${zoomSteps} (frame ${globalFrameNumber}, zoom step ${zoomStep})...`
					);

					// Calculate new tile size using zoom step within this iteration
					// Reset zoom progression for each iteration to maintain smooth transitions
					const baseTileSize = mosaicOptions.tileSize || defaultTileSize;
					const zoomMultiplier = Math.pow(1 / zoomFactor, zoomStep);
					const zoomTileSize = Math.round(baseTileSize * zoomMultiplier);
					if (prevZoomTileSize == zoomTileSize) {
						console.log(
							`Tile size ${zoomTileSize} pixels same as previous step, skipping redundant frame`
						);
						continue;
					}
					prevZoomTileSize = zoomTileSize;
					console.log(
						`Tile size: ${baseTileSize} -> ${zoomTileSize} pixels (continuous zoom factor: ${(
							zoomTileSize / baseTileSize
						).toFixed(2)}x)`
					);

					// Get target output dimensions (same as original)
					const targetWidth = mosaicResult.width;
					const targetHeight = mosaicResult.height;

					// Generate zoomed mosaic using same tile pattern but larger tiles
					await this.generateZoomedMosaicFromPattern(
						mosaicResult.tilePattern,
						mosaicResult.mosaicWidth,
						mosaicResult.mosaicHeight,
						zoomTileSize,
						targetWidth,
						targetHeight,
						zoomOutputPath,
						mosaicResult.tiles, // Pass tiles for optimization
						{ zoomPointX: currentZoomPointX, zoomPointY: currentZoomPointY } // Pass current zoom point
					);

					console.log(`Zoomed mosaic completed: ${zoomOutputPath}`);
				}

				// Set up for next iteration - use the last zoomed frame
				currentInputPath = `${baseOutputPath}_${globalFrameNumber
					.toString()
					.padStart(4, '0')}${extension}`;

				// Optional: Add a small delay to prevent system overload
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		} catch (error) {
			console.error(`Error during frame ${globalFrameNumber}:`, error.message);
			throw error;
		}

		console.log(
			`\nInfinite zoom mosaic completed ${globalFrameNumber} frames!`
		);
	}

	// Generate mosaic and return tile pattern for zoom reuse
	async generateMosaicWithTilePattern(
		inputImagePath,
		tilesDirectory,
		outputPath,
		options = {}
	) {
		const result = await this.generateMosaic(
			inputImagePath,
			tilesDirectory,
			outputPath,
			options
		);
		return {
			...result,
			tilePattern: this.lastTilePattern,
			mosaicWidth: this.lastMosaicWidth,
			mosaicHeight: this.lastMosaicHeight,
			tiles: this.lastTiles, // Store tiles for zoom operations
		};
	}

	// Generate zoomed mosaic from existing tile pattern with larger tile size
	async generateZoomedMosaicFromPattern(
		tilePattern,
		mosaicWidth,
		mosaicHeight,
		newTileSize,
		targetWidth,
		targetHeight,
		outputPath,
		tiles = null, // Add tiles parameter for optimization
		options = {}
	) {
		// Check if output file already exists
		try {
			await fs.access(outputPath);
			console.log(
				`Output file already exists, skipping generation: ${outputPath}`
			);
			return; // Skip generation
		} catch (error) {
			// File doesn't exist, continue with generation
		}

		// Use optimized version if tiles are provided
		// console.log(
		// 	`DEBUG: tiles parameter = ${
		// 		tiles ? 'PROVIDED' : 'NULL'
		// 	}, type = ${typeof tiles}`
		// );
		if (tiles && Array.isArray(tiles) && tiles.length > 0) {
			console.log(
				`Using OPTIMIZED smart cropping method with ${tiles.length} tiles available`
			);
			return this.generateZoomedMosaicFromPatternOptimized(
				tilePattern,
				mosaicWidth,
				mosaicHeight,
				newTileSize,
				targetWidth,
				targetHeight,
				outputPath,
				tiles,
				options.zoomPointX || 0.5,
				options.zoomPointY || 0.5
			);
		}

		// Fall back to original method if no tiles provided
		console.log(
			`WARNING: Using SLOW fallback method - tiles parameter not provided!`
		);
		console.log(
			`Compositing ${mosaicWidth}x${mosaicHeight} mosaic with ${newTileSize}px tiles...`
		);

		// Calculate full mosaic dimensions with larger tiles
		const fullWidth = mosaicWidth * newTileSize;
		const fullHeight = mosaicHeight * newTileSize;
		const startTime = new Date();

		console.log(
			`${new Date().toISOString()} : Full mosaic: ${fullWidth}x${fullHeight}, target: ${targetWidth}x${targetHeight}`
		);

		// Create rows of tiles using the existing pattern
		const rowBuffers = [];

		for (let y = 0; y < mosaicHeight; y++) {
			process.stdout.write(
				`\r${new Date().toISOString()} : Processing row ${
					y + 1
				} of ${mosaicHeight}`
			);

			// Process all tiles in this row
			const tileBuffers = [];
			for (let x = 0; x < mosaicWidth; x++) {
				const tilePath = tilePattern[y][x];
				try {
					const tileBuffer = await sharp(tilePath)
						.resize(newTileSize, newTileSize)
						.raw()
						.toBuffer();
					tileBuffers.push(tileBuffer);
				} catch (error) {
					console.warn(`Failed to load tile ${tilePath}, using solid gray`);
					// Create a solid gray fallback tile
					const fallbackBuffer = Buffer.alloc(
						newTileSize * newTileSize * 3,
						128
					);
					tileBuffers.push(fallbackBuffer);
				}
			}

			// Combine tiles horizontally to create a row
			const rowWidth = mosaicWidth * newTileSize;
			const rowHeight = newTileSize;
			const rowBuffer = Buffer.alloc(rowWidth * rowHeight * 3);

			for (let x = 0; x < mosaicWidth; x++) {
				const tileBuffer = tileBuffers[x];
				for (let ty = 0; ty < newTileSize; ty++) {
					for (let tx = 0; tx < newTileSize; tx++) {
						const srcOffset = (ty * newTileSize + tx) * 3;
						const dstOffset = (ty * rowWidth + (x * newTileSize + tx)) * 3;

						rowBuffer[dstOffset] = tileBuffer[srcOffset]; // R
						rowBuffer[dstOffset + 1] = tileBuffer[srcOffset + 1]; // G
						rowBuffer[dstOffset + 2] = tileBuffer[srcOffset + 2]; // B
					}
				}
			}

			rowBuffers.push(rowBuffer);
		}

		// Combine all rows vertically
		const finalBuffer = Buffer.concat(rowBuffers);

		// Create sharp instance from the full mosaic buffer
		let image = sharp(finalBuffer, {
			raw: {
				width: fullWidth,
				height: fullHeight,
				channels: 3,
			},
		});

		// Crop to target dimensions (center crop)
		if (fullWidth > targetWidth || fullHeight > targetHeight) {
			const left = Math.round((fullWidth - targetWidth) / 2);
			const top = Math.round((fullHeight - targetHeight) / 2);

			console.log(
				`Cropping: ${fullWidth}x${fullHeight} -> ${targetWidth}x${targetHeight} (offset: ${left},${top})`
			);

			image = image.extract({
				left: Math.max(0, left),
				top: Math.max(0, top),
				width: Math.min(targetWidth, fullWidth),
				height: Math.min(targetHeight, fullHeight),
			});
		}

		// Save the final image
		await image.png().toFile(outputPath);

		console.log(
			`Zoomed mosaic saved: ${outputPath} (${targetWidth}x${targetHeight}) in ${(
				(new Date() - startTime) /
				1000
			).toFixed(0)} secs`
		);
	}

	// Optimized mosaic composition using cached buffers
	async generateZoomedMosaicFromPatternOptimized(
		tilePattern,
		mosaicWidth,
		mosaicHeight,
		newTileSize,
		targetWidth,
		targetHeight,
		outputPath,
		tiles,
		zoomPointX = 0.5,
		zoomPointY = 0.5
	) {
		// Check if output file already exists
		try {
			await fs.access(outputPath);
			console.log(
				`Output file already exists, skipping generation: ${outputPath}`
			);
			return; // Skip generation
		} catch (error) {
			// File doesn't exist, continue with generation
		}

		console.log(
			`SMART CROPPING: ${mosaicWidth}x${mosaicHeight} mosaic with ${newTileSize}px tiles...`
		);

		const fullWidth = mosaicWidth * newTileSize;
		const fullHeight = mosaicHeight * newTileSize;
		const startTime = new Date();

		// Calculate crop region in tile coordinates based on zoom point
		// Use the zoom point parameters passed to the method
		const targetCenterX = Math.round(fullWidth * zoomPointX);
		const targetCenterY = Math.round(fullHeight * zoomPointY);
		const cropLeft = Math.max(
			0,
			Math.min(
				fullWidth - targetWidth,
				targetCenterX - Math.round(targetWidth / 2)
			)
		);
		const cropTop = Math.max(
			0,
			Math.min(
				fullHeight - targetHeight,
				targetCenterY - Math.round(targetHeight / 2)
			)
		);
		const cropRight = cropLeft + targetWidth;
		const cropBottom = cropTop + targetHeight;

		// Calculate which tiles are actually visible
		const startTileX = Math.max(0, Math.floor(cropLeft / newTileSize));
		const endTileX = Math.min(
			mosaicWidth - 1,
			Math.floor(cropRight / newTileSize)
		);
		const startTileY = Math.max(0, Math.floor(cropTop / newTileSize));
		const endTileY = Math.min(
			mosaicHeight - 1,
			Math.floor(cropBottom / newTileSize)
		);

		const visibleTilesX = endTileX - startTileX + 1;
		const visibleTilesY = endTileY - startTileY + 1;
		const totalVisibleTiles = visibleTilesX * visibleTilesY;
		const totalTiles = mosaicWidth * mosaicHeight;

		console.log(
			`Smart cropping: Only processing ${totalVisibleTiles}/${totalTiles} tiles (${Math.round(
				(totalVisibleTiles / totalTiles) * 100
			)}% of full image)`
		);
		console.log(
			`Visible region: tiles [${startTileX},${startTileY}] to [${endTileX},${endTileY}]`
		);

		// Calculate actual output dimensions - use target size directly
		const outputBuffer = Buffer.alloc(targetWidth * targetHeight * 3);

		// Process visible tiles in parallel batches
		const PARALLEL_ROWS = 8;
		const rowPromises = [];

		for (let startY = startTileY; startY <= endTileY; startY += PARALLEL_ROWS) {
			const endY = Math.min(startY + PARALLEL_ROWS - 1, endTileY);

			const rowPromise = this.processVisibleRowBatch(
				tilePattern,
				startY,
				endY,
				startTileX,
				endTileX,
				newTileSize,
				cropLeft,
				cropTop,
				targetWidth,
				targetHeight,
				outputBuffer
			);

			rowPromises.push(rowPromise);
		}

		// Process all row batches with progress tracking
		let completedBatches = 0;
		for (const rowPromise of rowPromises) {
			await rowPromise;
			completedBatches++;
			const progress = Math.round(
				(completedBatches / rowPromises.length) * 100
			);
			process.stdout.write(
				`\r${new Date().toISOString()} : Processing visible tiles: ${progress}%`
			);
		}
		console.log('');

		// Save directly without Sharp cropping
		await sharp(outputBuffer, {
			raw: { width: targetWidth, height: targetHeight, channels: 3 },
		})
			.png()
			.toFile(outputPath);

		console.log(
			`Smart cropped mosaic saved: ${outputPath} in ${(
				(new Date() - startTime) /
				1000
			).toFixed(0)} secs`
		);
	}

	// Process a batch of rows in parallel
	async processRowBatch(
		tilePattern,
		startY,
		endY,
		mosaicWidth,
		tileSize,
		fullWidth,
		finalBuffer
	) {
		const rowPromises = [];

		for (let y = startY; y < endY; y++) {
			const rowPromise = this.processRow(
				y,
				tilePattern[y],
				mosaicWidth,
				tileSize,
				fullWidth,
				finalBuffer
			);
			rowPromises.push(rowPromise);
		}

		await Promise.all(rowPromises);
	}

	// Process a single row
	async processRow(
		y,
		rowPattern,
		mosaicWidth,
		tileSize,
		fullWidth,
		finalBuffer
	) {
		const rowStartOffset = y * fullWidth * tileSize * 3;

		// Process tiles in this row in parallel
		const tilePromises = [];
		for (let x = 0; x < mosaicWidth; x++) {
			const tilePath = rowPattern[x];
			const tilePromise = this.placeTile(
				tilePath,
				x,
				y,
				tileSize,
				fullWidth,
				finalBuffer,
				rowStartOffset
			);
			tilePromises.push(tilePromise);
		}

		await Promise.all(tilePromises);
	}

	// Place a single tile in the final buffer
	async placeTile(
		tilePath,
		x,
		y,
		tileSize,
		fullWidth,
		finalBuffer,
		rowStartOffset
	) {
		let tileBuffer = await this.getCachedTileBuffer(tilePath, tileSize);

		if (!tileBuffer) {
			// Create gray fallback for corrupted tiles
			tileBuffer = Buffer.alloc(tileSize * tileSize * 3, 128);
		}

		// Copy tile data to final buffer
		const tileStartX = x * tileSize;

		for (let ty = 0; ty < tileSize; ty++) {
			const srcRowStart = ty * tileSize * 3;
			const dstRowStart = rowStartOffset + ty * fullWidth * 3 + tileStartX * 3;

			// Copy entire row of tile at once
			tileBuffer.copy(
				finalBuffer,
				dstRowStart,
				srcRowStart,
				srcRowStart + tileSize * 3
			);
		}
	}

	// Optimized batch processing with cached buffers
	async processRowBatchOptimized(
		tileImages,
		startY,
		endY,
		mosaicWidth,
		tileSize,
		finalWidth,
		finalBuffer,
		inputData
	) {
		const rowPromises = [];

		for (let y = startY; y < endY; y++) {
			const rowPromise = this.processRowOptimized(
				y,
				tileImages[y],
				mosaicWidth,
				tileSize,
				finalWidth,
				finalBuffer,
				inputData
			);
			rowPromises.push(rowPromise);
		}

		await Promise.all(rowPromises);
	}

	// Process a single row with cached buffers
	async processRowOptimized(
		y,
		rowTileImages,
		mosaicWidth,
		tileSize,
		finalWidth,
		finalBuffer,
		inputData
	) {
		// Process all tiles in this row in parallel
		const tilePromises = [];
		for (let x = 0; x < mosaicWidth; x++) {
			const tilePath = rowTileImages[x];
			const tilePromise = this.placeTileOptimized(
				tilePath,
				x,
				y,
				tileSize,
				finalWidth,
				finalBuffer,
				inputData,
				mosaicWidth
			);
			tilePromises.push(tilePromise);
		}

		await Promise.all(tilePromises);
	}

	// Place a single tile using cached buffer
	async placeTileOptimized(
		tilePath,
		x,
		y,
		tileSize,
		finalWidth,
		finalBuffer,
		inputData,
		mosaicWidth
	) {
		let tileBuffer = await this.getCachedTileBuffer(tilePath, tileSize);

		if (!tileBuffer) {
			// Handle corrupted tile with fallback
			console.warn(`Tile failed during compositing: ${tilePath}`);
			this.corruptedTiles.add(tilePath);

			// Get target color for replacement
			const pixelIndex = (y * mosaicWidth + x) * 3;
			const targetColor = {
				r: inputData[pixelIndex],
				g: inputData[pixelIndex + 1],
				b: inputData[pixelIndex + 2],
			};

			// Find replacement tile
			const availableTiles = this.lastTiles.filter(
				(tile) => !this.corruptedTiles.has(tile.path)
			);

			if (availableTiles.length > 0) {
				const replacementTile = this.findBestTile(targetColor, availableTiles);
				tileBuffer = await this.getCachedTileBuffer(
					replacementTile.path,
					tileSize
				);
			}

			// Final fallback to gray tile
			if (!tileBuffer) {
				tileBuffer = Buffer.alloc(tileSize * tileSize * 3, 128);
			}
		}

		// Calculate position in final buffer
		const startX = x * tileSize;
		const startY = y * tileSize;

		// Copy tile data efficiently using bulk operations
		for (let ty = 0; ty < tileSize; ty++) {
			const srcRowStart = ty * tileSize * 3;
			const dstRowStart = (startY + ty) * finalWidth * 3 + startX * 3;

			// Copy entire row of the tile at once - much faster than pixel by pixel
			tileBuffer.copy(
				finalBuffer,
				dstRowStart,
				srcRowStart,
				srcRowStart + tileSize * 3
			);
		}
	}

	// Process only visible tile rows for smart cropping
	async processVisibleRowBatch(
		tilePattern,
		startY,
		endY,
		startTileX,
		endTileX,
		tileSize,
		cropLeft,
		cropTop,
		targetWidth,
		targetHeight,
		outputBuffer
	) {
		const rowPromises = [];

		for (let y = startY; y <= endY; y++) {
			const rowPromise = this.processVisibleRow(
				y,
				tilePattern[y],
				startTileX,
				endTileX,
				tileSize,
				cropLeft,
				cropTop,
				targetWidth,
				targetHeight,
				outputBuffer
			);
			rowPromises.push(rowPromise);
		}

		await Promise.all(rowPromises);
	}

	// Process a single row of visible tiles
	async processVisibleRow(
		y,
		rowPattern,
		startTileX,
		endTileX,
		tileSize,
		cropLeft,
		cropTop,
		targetWidth,
		targetHeight,
		outputBuffer
	) {
		// Process tiles in this row in parallel
		const tilePromises = [];
		for (let x = startTileX; x <= endTileX; x++) {
			const tilePath = rowPattern[x];
			const tilePromise = this.placeVisibleTile(
				tilePath,
				x,
				y,
				tileSize,
				cropLeft,
				cropTop,
				targetWidth,
				targetHeight,
				outputBuffer
			);
			tilePromises.push(tilePromise);
		}

		await Promise.all(tilePromises);
	}

	// Simplified tile placement - just copy entire tiles for now to avoid buffer errors
	async placeVisibleTile(
		tilePath,
		x,
		y,
		tileSize,
		cropLeft,
		cropTop,
		targetWidth,
		targetHeight,
		outputBuffer
	) {
		let tileBuffer = await this.getCachedTileBuffer(tilePath, tileSize);

		if (!tileBuffer) {
			// Create gray fallback for corrupted tiles
			tileBuffer = Buffer.alloc(tileSize * tileSize * 3, 128);
		}

		// Calculate tile position in full mosaic coordinates
		const tileStartX = x * tileSize;
		const tileStartY = y * tileSize;

		// Calculate output position (where this tile should go in final image)
		const outputStartX = tileStartX - cropLeft;
		const outputStartY = tileStartY - cropTop;

		// Skip if tile is completely outside target area
		if (
			outputStartX + tileSize <= 0 ||
			outputStartY + tileSize <= 0 ||
			outputStartX >= targetWidth ||
			outputStartY >= targetHeight
		) {
			return;
		}

		// For now, copy entire tile (we can optimize cropping later)
		for (let ty = 0; ty < tileSize; ty++) {
			const outputY = outputStartY + ty;
			if (outputY < 0 || outputY >= targetHeight) continue;

			for (let tx = 0; tx < tileSize; tx++) {
				const outputX = outputStartX + tx;
				if (outputX < 0 || outputX >= targetWidth) continue;

				const srcOffset = (ty * tileSize + tx) * 3;
				const dstOffset = (outputY * targetWidth + outputX) * 3;

				// Copy RGB values
				if (
					srcOffset + 2 < tileBuffer.length &&
					dstOffset + 2 < outputBuffer.length
				) {
					outputBuffer[dstOffset] = tileBuffer[srcOffset]; // R
					outputBuffer[dstOffset + 1] = tileBuffer[srcOffset + 1]; // G
					outputBuffer[dstOffset + 2] = tileBuffer[srcOffset + 2]; // B
				}
			}
		}
	} // Generate the mosaic
	async generateMosaic(
		inputImagePath,
		tilesDirectory,
		outputPath,
		options = {}
	) {
		// Check if output file already exists (only if we're not skipping file write)
		if (outputPath && !options.skipFileWrite) {
			try {
				await fs.access(outputPath);
				console.log(
					`Output file already exists, skipping generation: ${outputPath}`
				);
				// Return minimal result data for compatibility
				const existingImage = sharp(outputPath);
				const metadata = await existingImage.metadata();
				return {
					width: metadata.width,
					height: metadata.height,
					tilesUsed: 0,
					availableTiles: 0,
					corruptedTiles: 0,
				};
			} catch (error) {
				// File doesn't exist, continue with generation
			}
		}

		const {
			outputWidth = defaultOutputWidth, // Target output image width in pixels
			outputHeight = null, // Target output image height in pixels (auto if null)
			mosaicWidth = null, // Number of tiles horizontally (computed if null)
			mosaicHeight = null, // Number of tiles vertically (auto if null)
			tileSize = defaultTileSize, // Size of each tile in pixels
		} = options;

		// Compute mosaic dimensions based on output resolution
		const computedMosaicWidth =
			mosaicWidth || Math.round(outputWidth / tileSize);
		const finalMosaicWidth = computedMosaicWidth;

		this.tileSize = tileSize;

		// Initialize disk cache for tile buffers
		await this.initializeDiskCache(tilesDirectory);

		console.log('Loading input image...');
		const inputMetadata = await sharp(inputImagePath).metadata();

		// Try to load cached tile data first
		const cacheFilePath = path.join(tilesDirectory, 'tiles.csv');
		console.log('Checking for tile cache...');
		let tiles = await this.loadTileCacheFromCSV(cacheFilePath);
		let tileFiles = [];

		if (tiles) {
			console.log(`Loaded ${tiles.length} tiles from cache`);

			// Validate cached tiles have proper extensions and exist
			tiles = tiles.filter((tile) => {
				if (!tile || !tile.path) {
					return false;
				}
				if (!isImage(tile.path)) {
					console.warn(
						`Removing invalid cached tile (no image extension): ${tile.path}`
					);
					this.corruptedTiles.add(tile.path);
					return false;
				}

				return true;
			});

			// Get tile files from cache instead of scanning directory
			tileFiles = tiles.map((tile) => tile.path);
			// console.log('Checking for new tile images...');
			// const allTileFiles = await this.getImageFiles(tilesDirectory);
			// const cachedPaths = new Set(tileFiles);
			// const newTileFiles = allTileFiles.filter(
			// 	(file) => !cachedPaths.has(file)
			// );

			// if (newTileFiles.length > 0) {
			// 	console.log(`Found ${newTileFiles.length} new tile images`);
			// 	tileFiles = allTileFiles; // Use all files for processing
			// } else {
			// 	console.log('No new tiles found');
			// }

			// Check if we have new files not in cache
			const cachedPaths = new Set(tiles.map((tile) => tile.path));
			const newTileFiles = tileFiles.filter((file) => !cachedPaths.has(file));

			if (newTileFiles.length > 0) {
				console.log(
					`${new Date().toISOString()} : Processing ${
						newTileFiles.length
					} new tile images...`
				);
				let processed = 0;

				for (const tileFile of newTileFiles) {
					const tileData = await this.getAverageColor(tileFile);
					if (tileData) {
						tiles.push(tileData);
					}
					processed++;
					if (processed % 50 === 0) {
						process.stdout.write(
							`\rProcessed ${processed}/${newTileFiles.length} new tiles`
						);
					}
				}

				// Save updated cache
				await this.saveTileCacheToCSV(tiles, cacheFilePath);
			} else {
				console.log('No new tiles to process');
			}
		} else {
			console.log(
				`No cache found at ${cacheFilePath}. Scanning for tile images...`
			);
			tileFiles = await this.getImageFiles(tilesDirectory);

			console.log(`Found ${tileFiles.length} tile images`);
			tiles = [];
			let processed = 0;

			for (const tileFile of tileFiles) {
				const tileData = await this.getAverageColor(tileFile);
				if (tileData) {
					tiles.push(tileData);
				}
				processed++;
				if (processed % 50 === 0) {
					process.stdout.write(
						`\rProcessed ${processed}/${tileFiles.length} tiles`
					);
				}
			}

			// Save cache for next time
			await this.saveTileCacheToCSV(tiles, cacheFilePath);
		}

		// Filter out null entries (corrupted tiles)
		tiles = tiles.filter((tile) => tile !== null);

		if (tiles.length === 0) {
			throw new Error('No valid tile images could be processed');
		}

		// Store tiles for zoom operations
		this.lastTiles = tiles;

		console.log(`Processed ${tiles.length} valid tiles`);
		if (this.corruptedTiles.size > 0) {
			console.log(
				`Excluded ${this.corruptedTiles.size} corrupted tiles from selection`
			);
		}

		// Calculate mosaic dimensions
		const aspectRatio = inputMetadata.height / inputMetadata.width;
		const computedMosaicHeight = outputHeight
			? Math.round(outputHeight / tileSize)
			: Math.round(finalMosaicWidth * aspectRatio);
		const finalMosaicHeight = mosaicHeight || computedMosaicHeight;

		// Resize input image to mosaic grid size for color analysis
		console.log('Analyzing input image colors...');
		const { data: inputData } = await sharp(inputImagePath)
			.resize(finalMosaicWidth, finalMosaicHeight)
			.raw()
			.toBuffer({ resolveWithObject: true });

		console.log(
			`Generating ${finalMosaicWidth}x${finalMosaicHeight} mosaic...`
		);

		const usedTiles = new Set(); // For --no-reuse compatibility
		const tileUsageCount = new Map(); // Track usage count for max-unique-tiles
		const tileImages = [];

		// Extract maxUniqueTiles from options
		const maxUniqueTiles = options.maxUniqueTiles || 0;

		// Generate mosaic tile by tile
		for (let y = 0; y < finalMosaicHeight; y++) {
			const row = [];
			for (let x = 0; x < finalMosaicWidth; x++) {
				// Get color of this pixel in the scaled input image
				const pixelIndex = (y * finalMosaicWidth + x) * 3;
				const targetColor = {
					r: inputData[pixelIndex],
					g: inputData[pixelIndex + 1],
					b: inputData[pixelIndex + 2],
				};

				// Find best matching tile based on reuse constraints
				let availableTiles = tiles;

				if (maxUniqueTiles > 0) {
					// New max-unique-tiles behavior
					availableTiles = tiles.filter((tile) => {
						const currentUsage = tileUsageCount.get(tile.path) || 0;
						return currentUsage < maxUniqueTiles;
					});
					if (availableTiles.length === 0) {
						availableTiles = tiles; // Fallback to all tiles if we run out
					}
				}

				const bestTile = this.findBestTile(targetColor, availableTiles);

				// Update usage tracking
				if (maxUniqueTiles > 0) {
					const currentUsage = tileUsageCount.get(bestTile.path) || 0;
					tileUsageCount.set(bestTile.path, currentUsage + 1);
				}

				row.push(bestTile.path);
			}
			tileImages.push(row);

			// Progress indicator - overwrite same line
			if ((y + 1) % 10 === 0 || y === finalMosaicHeight - 1) {
				const progress = Math.round(((y + 1) / finalMosaicHeight) * 100);
				process.stdout.write(`\rProgress: ${progress}%`);

				// Add newline only when complete
				if (y === finalMosaicHeight - 1) {
					process.stdout.write('\n');
				}
			}
		}

		// Store tile pattern for zoom operations
		this.lastTilePattern = tileImages;
		this.lastMosaicWidth = finalMosaicWidth;
		this.lastMosaicHeight = finalMosaicHeight;

		// Pre-cache all tiles that will be used in this mosaic
		await this.preCacheTileBuffers(tileImages, tileSize);

		console.log(
			`${new Date().toISOString()} : Compositing final ${finalMosaicWidth} x ${finalMosaicHeight} mosaic...`
		);

		// Use optimized compositing
		const finalWidth = finalMosaicWidth * tileSize;
		const finalHeight = finalMosaicHeight * tileSize;
		const startTime = new Date();

		// Create final buffer and process in parallel
		const finalBuffer = Buffer.alloc(finalWidth * finalHeight * 3);

		// Process multiple rows in parallel
		const PARALLEL_ROWS = 8; // Adjust based on your system
		const rowPromises = [];

		for (let startY = 0; startY < finalMosaicHeight; startY += PARALLEL_ROWS) {
			const endY = Math.min(startY + PARALLEL_ROWS, finalMosaicHeight);

			const rowPromise = this.processRowBatchOptimized(
				tileImages,
				startY,
				endY,
				finalMosaicWidth,
				tileSize,
				finalWidth,
				finalBuffer,
				inputData
			);

			rowPromises.push(rowPromise);
		}

		// Process all row batches with progress tracking
		let completedBatches = 0;
		for (const rowPromise of rowPromises) {
			await rowPromise;
			completedBatches++;
			const rowsCompleted = Math.min(
				completedBatches * PARALLEL_ROWS,
				finalMosaicHeight
			);
			const progress = Math.round((rowsCompleted / finalMosaicHeight) * 100);
			process.stdout.write(
				`\r${new Date().toISOString()} : Processing row ${rowsCompleted} of ${finalMosaicHeight} (${progress}%)`
			);
		}
		console.log('');

		// Save the final image (only if not skipping file write)
		if (outputPath && !options.skipFileWrite) {
			await sharp(finalBuffer, {
				raw: {
					width: finalWidth,
					height: finalHeight,
					channels: 3,
				},
			})
				.png()
				.toFile(outputPath);

			console.log(
				`Mosaic saved to: ${outputPath} in ${(
					(new Date() - startTime) /
					1000
				).toFixed(0)} secs`
			);
		} else {
			console.log(
				`Mosaic generation completed (no file saved) in ${(
					(new Date() - startTime) /
					1000
				).toFixed(0)} secs`
			);
		}
		console.log(`Final size: ${finalWidth}x${finalHeight} pixels`);
		console.log(
			`Tiles used: ${finalMosaicWidth}x${finalMosaicHeight} = ${
				finalMosaicWidth * finalMosaicHeight
			} total`
		);

		// Print cache statistics
		await this.printCacheStats(tileSize);

		if (this.corruptedTiles.size > 0) {
			console.log(
				`Corrupted tiles found and excluded: ${this.corruptedTiles.size}`
			);
		}

		return {
			width: finalWidth,
			height: finalHeight,
			tilesUsed: finalMosaicWidth * finalMosaicHeight,
			availableTiles: tiles.length,
			corruptedTiles: this.corruptedTiles.size,
		};
	}
}

// CLI interface
async function main() {
	const args = process.argv.slice(2);

	if (args.length < 3) {
		console.log(
			'Usage: node main.cjs <input-image> <tiles-directory> <output-image> [options]'
		);
		console.log('');
		console.log('Options:');
		console.log(
			`  --output-width <number>   Target output image width in pixels (default: ${defaultOutputWidth})`
		);
		console.log(
			'  --output-height <number>  Target output image height in pixels (auto if not specified)'
		);
		console.log(
			'  --tile-width <number>     Number of tiles horizontally (overrides output-width)'
		);
		console.log(
			'  --tile-height <number>    Number of tiles vertically (auto if not specified)'
		);
		console.log(
			`  --tile-size <number>      Size of each tile in pixels (default: ${defaultTileSize})`
		);
		console.log(
			"  --no-reuse           Don't reuse tiles (may result in lower quality)"
		);
		console.log(
			'  --max-unique-tiles <num>  Max times a tile can be used (0=unlimited, 1=unique, etc.)'
		);
		console.log('  --infinite-zoom      Generate infinite zoom sequence');
		console.log(
			`  --zoom-factor <num>  Zoom factor per iteration (default: ${defaultZoomFactor} = ${Math.round(
				(1 - defaultZoomFactor) * 100
			)}% zoom out per iteration)`
		);
		console.log(
			`  --zoom-steps <num>   Number of zoom steps between mosaics (default: ${defaultZoomSteps})`
		);
		console.log(
			'  --max-iterations <n> Maximum iterations (default: infinite)'
		);
		console.log(
			'  --zoom-point-x <num> Horizontal zoom point as fraction 0.0-1.0 (default: 0.5 = center)'
		);
		console.log(
			'  --zoom-point-y <num> Vertical zoom point as fraction 0.0-1.0 (default: 0.5 = center)'
		);
		console.log(
			'  --random-zoom-motion <num> Random zoom point movement with Gaussian distribution (mean motion amount)'
		);
		console.log('');
		console.log('Examples:');
		console.log(
			'  node main.cjs photo.jpg ./tiles output.png --output-width 6000 --tile-size 24'
		);
		console.log(
			'  node main.cjs photo.jpg ./tiles output.png --tile-width 150 --tile-size 24'
		);
		console.log(
			'  node main.cjs photo.jpg ./tiles zoom_sequence.png --infinite-zoom'
		);
		console.log(
			'  node main.cjs photo.jpg ./tiles zoom.png --infinite-zoom --max-iterations 5'
		);
		console.log(
			'  node main.cjs photo.jpg ./tiles zoom.png --infinite-zoom --zoom-steps 6'
		);
		console.log(
			'  node main.cjs photo.jpg ./tiles zoom.png --infinite-zoom --zoom-point-x 0.4 --zoom-point-y 0.4'
		);
		process.exit(1);
	}

	const [inputImage, tilesDirectory, outputImage] = args;

	// Parse options
	const options = {
		outputWidth: defaultOutputWidth,
		outputHeight: null,
		mosaicWidth: null, // Number of tiles (overrides outputWidth)
		mosaicHeight: null,
		tileSize: defaultTileSize,
		maxUniqueTiles: 0, // 0 = unlimited reuse
		infiniteZoom: false,
		zoomFactor: defaultZoomFactor,
		zoomSteps: defaultZoomSteps,
		maxIterations: null,
		zoomPointX: 0.5, // Default to center
		zoomPointY: 0.5, // Default to center
		randomZoomMotion: 0, // Default to no random motion
	};

	for (let i = 3; i < args.length; i++) {
		switch (args[i]) {
			case '--output-width':
				options.outputWidth = parseInt(args[++i]);
				break;
			case '--output-height':
				options.outputHeight = parseInt(args[++i]);
				break;
			case '--tile-width':
				options.mosaicWidth = parseInt(args[++i]);
				break;
			case '--tile-height':
				options.mosaicHeight = parseInt(args[++i]);
				break;
			case '--width': // Legacy support
				options.mosaicWidth = parseInt(args[++i]);
				break;
			case '--height': // Legacy support
				options.mosaicHeight = parseInt(args[++i]);
				break;
			case '--tile-size':
				options.tileSize = parseInt(args[++i]);
				break;
			case '--max-unique-tiles':
				options.maxUniqueTiles = parseInt(args[++i]);
				break;
			case '--infinite-zoom':
				options.infiniteZoom = true;
				break;
			case '--zoom-factor':
				options.zoomFactor = parseFloat(args[++i]);
				break;
			case '--zoom-steps':
				options.zoomSteps = parseInt(args[++i]);
				break;
			case '--max-iterations':
				options.maxIterations = parseInt(args[++i]);
				break;
			case '--zoom-point-x':
				options.zoomPointX = parseFloat(args[++i]);
				break;
			case '--zoom-point-y':
				options.zoomPointY = parseFloat(args[++i]);
				break;
			case '--random-zoom-motion':
				options.randomZoomMotion = parseFloat(args[++i]);
				break;
		}
	}

	try {
		// Verify input files exist
		await fs.access(inputImage);
		await fs.access(tilesDirectory);

		const generator = new MosaicGenerator();

		if (options.infiniteZoom) {
			// Generate infinite zoom sequence
			console.log('Starting infinite zoom mosaic generation...');
			console.log(
				`Zoom factor: ${options.zoomFactor} (${Math.round(
					(1 - options.zoomFactor) * 100
				)}% zoom per iteration)`
			);
			if (options.maxIterations) {
				console.log(`Maximum iterations: ${options.maxIterations}`);
			} else {
				console.log('Maximum iterations: infinite (press Ctrl+C to stop)');
			}

			await generator.generateInfiniteZoomMosaic(
				inputImage,
				tilesDirectory,
				outputImage,
				options
			);

			console.log('\nInfinite zoom mosaic sequence completed!');
		} else {
			// Generate single mosaic
			const result = await generator.generateMosaic(
				inputImage,
				tilesDirectory,
				outputImage,
				options
			);

			console.log('\nMosaic generation completed successfully!');
		}

		console.log(`Input: ${inputImage}`);
		console.log(`Output: ${outputImage}`);
		console.log(`Tiles directory: ${tilesDirectory}`);
	} catch (error) {
		console.error('Error:', error.message);
		process.exit(1);
	}
}

// Run if called directly
if (require.main === module) {
	main().catch(console.error);
}

module.exports = { MosaicGenerator };

// Generate Gaussian random number using Box-Muller transform
function gaussianRandom(mean = 0, stdDev = 1) {
	let u = 0,
		v = 0;
	while (u === 0) u = Math.random(); // Converting [0,1) to (0,1)
	while (v === 0) v = Math.random();
	const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
	return z * stdDev + mean;
}

function isImage(filename) {
	if (filename) {
		const ext = path.extname(filename).toLowerCase();
		// console.log(`filename: ${filename}, ext: ${ext}`);
		return imageExtensions.includes(ext);
	}
	return false;
}
