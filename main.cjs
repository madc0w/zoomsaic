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
// const Jimp = require('jimp');

const defaultTileSize = 6;
const defaultOutputWidth = 1200; // Default output image width in pixels
const defaultZoomSteps = 8;

class MosaicGenerator {
	constructor() {
		this.tileCache = new Map();
		this.tileSize = defaultTileSize; // Size of each mosaic tile
		this.corruptedTiles = new Set(); // Track corrupted tiles to avoid reusing them
	}

	// Get all image files from directory and subdirectories
	async getImageFiles(dir) {
		const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
		const files = [];

		async function scanDirectory(currentDir) {
			try {
				const items = await fs.readdir(currentDir);

				for (const item of items) {
					const fullPath = path.join(currentDir, item);
					const stat = await fs.stat(fullPath);

					if (stat.isDirectory()) {
						await scanDirectory(fullPath);
					} else if (
						imageExtensions.includes(path.extname(item).toLowerCase())
					) {
						files.push(fullPath);
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

	// Find the best matching tile for a given color
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
				const [path, r, g, b] = lines[i].split(',');
				if (path && r && g && b) {
					const tileData = {
						path: path.trim(),
						r: parseInt(r.trim()),
						g: parseInt(g.trim()),
						b: parseInt(b.trim()),
					};
					tiles.push(tileData);
					this.tileCache.set(tileData.path, tileData);
				}
			}

			return tiles;
		} catch (error) {
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

	// Zoom into center of image by specified percentage
	async zoomImage(imagePath, zoomFactor = 0.9) {
		const image = sharp(imagePath);
		const metadata = await image.metadata();

		const { width, height } = metadata;
		const newWidth = Math.round(width * zoomFactor);
		const newHeight = Math.round(height * zoomFactor);

		// Calculate center crop coordinates
		const left = Math.round((width - newWidth) / 2);
		const top = Math.round((height - newHeight) / 2);

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
			zoomFactor = 0.9, // 10% zoom each iteration
			maxIterations = null, // null for infinite
			zoomSteps = defaultZoomSteps, // Number of zoom steps between mosaics
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

				// Generate mosaic first and capture tile pattern
				globalFrameNumber++;
				const paddedFrameNumber = globalFrameNumber.toString().padStart(4, '0');
				const mosaicOutputPath = `${baseOutputPath}_${paddedFrameNumber}${extension}`;

				console.log(`Generating initial mosaic frame ${globalFrameNumber}...`);
				const mosaicResult = await this.generateMosaicWithTilePattern(
					currentInputPath,
					tilesDirectory,
					mosaicOutputPath,
					mosaicOptions
				);

				console.log(`Mosaic completed: ${mosaicOutputPath}`);

				// Now generate zoom sequence by reusing tile pattern with larger tile sizes
				for (let zoomStep = 1; zoomStep <= zoomSteps; zoomStep++) {
					globalFrameNumber++;
					const paddedZoomFrame = globalFrameNumber.toString().padStart(4, '0');
					const zoomOutputPath = `${baseOutputPath}_${paddedZoomFrame}${extension}`;

					console.log(
						`Creating zoomed mosaic ${zoomStep}/${zoomSteps} (frame ${globalFrameNumber})...`
					);

					// Calculate new tile size (tiles get LARGER with each zoom step)
					// If zoomFactor = 0.9, then tiles grow by 1/0.9 = 1.111x each step
					const baseTileSize = mosaicOptions.tileSize || defaultTileSize;
					const zoomMultiplier = Math.pow(1 / zoomFactor, zoomStep);
					const zoomTileSize = Math.round(baseTileSize * zoomMultiplier);

					console.log(
						`Tile size: ${baseTileSize} -> ${zoomTileSize} pixels (zoom factor: ${(
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
						zoomOutputPath
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
		outputPath
	) {
		console.log(
			`Compositing ${mosaicWidth}x${mosaicHeight} mosaic with ${newTileSize}px tiles...`
		);

		// Calculate full mosaic dimensions with larger tiles
		const fullWidth = mosaicWidth * newTileSize;
		const fullHeight = mosaicHeight * newTileSize;
		const startTime = new Date();

		console.log(
			`Full mosaic: ${fullWidth}x${fullHeight}, target: ${targetWidth}x${targetHeight}`
		);

		// Create rows of tiles using the existing pattern
		const rowBuffers = [];

		for (let y = 0; y < mosaicHeight; y++) {
			console.log(
				`${new Date().toISOString()} : Processing row ${
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

	// Generate the mosaic
	async generateMosaic(
		inputImagePath,
		tilesDirectory,
		outputPath,
		options = {}
	) {
		const {
			outputWidth = defaultOutputWidth, // Target output image width in pixels
			outputHeight = null, // Target output image height in pixels (auto if null)
			mosaicWidth = null, // Number of tiles horizontally (computed if null)
			mosaicHeight = null, // Number of tiles vertically (auto if null)
			tileSize = defaultTileSize, // Size of each tile in pixels
			allowReuse = true, // Allow tiles to be reused
		} = options;

		// Compute mosaic dimensions based on output resolution
		const computedMosaicWidth =
			mosaicWidth || Math.round(outputWidth / tileSize);
		const finalMosaicWidth = computedMosaicWidth;

		this.tileSize = tileSize;

		console.log('Loading input image...');
		const inputMetadata = await sharp(inputImagePath).metadata();

		// Try to load cached tile data first
		const cacheFilePath = path.join(tilesDirectory, 'tiles.csv');
		console.log('Checking for tile cache...');
		let tiles = await this.loadTileCacheFromCSV(cacheFilePath);
		let tileFiles = [];

		if (tiles) {
			console.log(`Loaded ${tiles.length} tiles from cache`);

			// Just blacklist known problematic files without validation
			const knownCorruptedFiles = [
				'\\TINYTIM\\Quaffle\\Multimedia\\Misc\\European art\\W\\WILLIAM-ADOLPHE Bouguereau\\WILLIAM-ADOLPHE Bouguereau - Madonna-Roses.jpg',
			];

			// Add known corrupted files to blacklist
			knownCorruptedFiles.forEach((path) => {
				this.corruptedTiles.add(path);
			});
			console.log(
				`Blacklisted ${knownCorruptedFiles.length} known problematic tiles`
			);

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
		} else {
			// No cache exists, need to scan all files
			console.log('Scanning for tile images...');
			tileFiles = await this.getImageFiles(tilesDirectory);

			if (tileFiles.length === 0) {
				throw new Error(`No image files found in ${tilesDirectory}`);
			}

			console.log(`Found ${tileFiles.length} tile images`);
		}

		if (tiles) {
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
			console.log('No cache found. Processing all tile images...');
			tiles = [];
			let processed = 0;

			for (const tileFile of tileFiles) {
				const tileData = await this.getAverageColor(tileFile);
				if (tileData) {
					tiles.push(tileData);
				}
				processed++;
				if (processed % 50 === 0) {
					console.log(`Processed ${processed}/${tileFiles.length} tiles`);
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

		const usedTiles = new Set();
		const tileImages = [];

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

				// Find best matching tile
				let availableTiles = tiles;
				if (!allowReuse) {
					availableTiles = tiles.filter((tile) => !usedTiles.has(tile));
					if (availableTiles.length === 0) {
						availableTiles = tiles; // Fallback to all tiles if we run out
					}
				}

				const bestTile = this.findBestTile(targetColor, availableTiles);

				if (!allowReuse) {
					usedTiles.add(bestTile);
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

		console.log(
			`Compositing final ${finalMosaicWidth} x ${finalMosaicHeight} mosaic...`
		);

		// Create final mosaic more efficiently by processing row by row
		const finalWidth = finalMosaicWidth * tileSize;
		const finalHeight = finalMosaicHeight * tileSize;

		const startTime = new Date();

		// Create rows of tiles and then combine them
		const rowBuffers = [];

		for (let y = 0; y < finalMosaicHeight; y++) {
			console.log(
				`${new Date().toISOString()} : Processing row ${
					y + 1
				} of ${finalMosaicHeight}`
			);

			// Process all tiles in this row
			const tileBuffers = [];
			for (let x = 0; x < finalMosaicWidth; x++) {
				const tilePath = tileImages[y][x];
				try {
					const tileBuffer = await sharp(tilePath)
						.resize(tileSize, tileSize)
						.raw()
						.toBuffer();
					tileBuffers.push(tileBuffer);
				} catch (error) {
					console.warn(
						`Tile failed during compositing at row ${y + 1}, column ${
							x + 1
						}: ${tilePath}`
					);
					console.warn(`Error details: ${error.message}`);

					// Mark this tile as corrupted for future avoidance
					this.corruptedTiles.add(tilePath);

					// Find a replacement tile on the fly
					const pixelIndex = (y * finalMosaicWidth + x) * 3;
					const targetColor = {
						r: inputData[pixelIndex],
						g: inputData[pixelIndex + 1],
						b: inputData[pixelIndex + 2],
					};

					// Get available tiles excluding corrupted ones
					const availableTiles = tiles.filter(
						(tile) => !this.corruptedTiles.has(tile.path)
					);
					if (availableTiles.length === 0) {
						throw new Error(
							'No valid tiles remaining after filtering corrupted tiles'
						);
					}

					const replacementTile = this.findBestTile(
						targetColor,
						availableTiles
					);
					console.warn(`Using replacement tile: ${replacementTile.path}`);

					// Process the replacement tile
					const tileBuffer = await sharp(replacementTile.path)
						.resize(tileSize, tileSize)
						.raw()
						.toBuffer();
					tileBuffers.push(tileBuffer);
				}
			}

			// Combine tiles horizontally to create a row
			const rowWidth = finalMosaicWidth * tileSize;
			const rowHeight = tileSize;
			const rowBuffer = Buffer.alloc(rowWidth * rowHeight * 3);

			for (let x = 0; x < finalMosaicWidth; x++) {
				const tileBuffer = tileBuffers[x];
				for (let ty = 0; ty < tileSize; ty++) {
					for (let tx = 0; tx < tileSize; tx++) {
						const srcOffset = (ty * tileSize + tx) * 3;
						const dstOffset = (ty * rowWidth + (x * tileSize + tx)) * 3;

						rowBuffer[dstOffset] = tileBuffer[srcOffset]; // R
						rowBuffer[dstOffset + 1] = tileBuffer[srcOffset + 1]; // G
						rowBuffer[dstOffset + 2] = tileBuffer[srcOffset + 2]; // B
					}
				}
			}

			rowBuffers.push(rowBuffer);
		}

		console.log('Combining rows into final image...');

		// Combine all rows vertically
		const finalBuffer = Buffer.concat(rowBuffers);

		// Save the final image
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
		console.log(`Final size: ${finalWidth}x${finalHeight} pixels`);
		console.log(
			`Tiles used: ${finalMosaicWidth}x${finalMosaicHeight} = ${
				finalMosaicWidth * finalMosaicHeight
			} total`
		);

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
		console.log('  --infinite-zoom      Generate infinite zoom sequence');
		console.log(
			'  --zoom-factor <num>  Zoom factor per iteration (default: 0.9 = 10% zoom)'
		);
		console.log(
			`  --zoom-steps <num>   Number of zoom steps between mosaics (default: ${defaultZoomSteps})`
		);
		console.log(
			'  --max-iterations <n> Maximum iterations (default: infinite)'
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
		allowReuse: true,
		infiniteZoom: false,
		zoomFactor: 0.9,
		zoomSteps: defaultZoomSteps,
		maxIterations: null,
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
			case '--no-reuse':
				options.allowReuse = false;
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
