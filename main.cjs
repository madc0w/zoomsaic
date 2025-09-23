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

const defaultTileSize = 40;
const defaultMosaicWidth = 120;
const defaultZoomSteps = 4;

class MosaicGenerator {
	constructor() {
		this.tileCache = new Map();
		this.tileSize = defaultTileSize; // Size of each mosaic tile
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
		if (this.tileCache.has(imagePath)) {
			return this.tileCache.get(imagePath);
		}

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
			console.warn(
				`Warning: Could not process image ${imagePath}: ${error.message}`
			);
			return null;
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
		let bestTile = tiles[0];
		let bestDistance = this.colorDistanceSq(targetColor, bestTile);

		for (let i = 1; i < tiles.length; i++) {
			const distance = this.colorDistanceSq(targetColor, tiles[i]);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestTile = tiles[i];
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

				// Generate mosaic first
				globalFrameNumber++;
				const paddedFrameNumber = globalFrameNumber.toString().padStart(4, '0');
				const mosaicOutputPath = `${baseOutputPath}_${paddedFrameNumber}${extension}`;

				console.log(`Generating mosaic frame ${globalFrameNumber}...`);
				await this.generateMosaic(
					currentInputPath,
					tilesDirectory,
					mosaicOutputPath,
					mosaicOptions
				);

				console.log(`Mosaic completed: ${mosaicOutputPath}`);

				// Now generate the zoom sequence
				let zoomInputPath = mosaicOutputPath;

				for (let zoomStep = 1; zoomStep <= zoomSteps; zoomStep++) {
					globalFrameNumber++;
					const paddedZoomFrame = globalFrameNumber.toString().padStart(4, '0');
					const zoomOutputPath = `${baseOutputPath}_${paddedZoomFrame}${extension}`;

					console.log(
						`Creating zoom step ${zoomStep}/${zoomSteps} (frame ${globalFrameNumber})...`
					);

					// Create zoomed version and save it directly
					const image = sharp(zoomInputPath);
					const metadata = await image.metadata();

					const { width, height } = metadata;
					const newWidth = Math.round(width * zoomFactor);
					const newHeight = Math.round(height * zoomFactor);

					// Calculate center crop coordinates
					const left = Math.round((width - newWidth) / 2);
					const top = Math.round((height - newHeight) / 2);

					await image
						.extract({ left, top, width: newWidth, height: newHeight })
						.resize(width, height) // Scale back to original dimensions
						.png()
						.toFile(zoomOutputPath);

					console.log(`Zoom step completed: ${zoomOutputPath}`);
					zoomInputPath = zoomOutputPath;
				}

				// Set up for next iteration
				currentInputPath = zoomInputPath;

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

	// Generate the mosaic
	async generateMosaic(
		inputImagePath,
		tilesDirectory,
		outputPath,
		options = {}
	) {
		const {
			mosaicWidth = defaultMosaicWidth, // Number of tiles horizontally
			mosaicHeight = null, // Number of tiles vertically (auto if null)
			tileSize = defaultTileSize, // Size of each tile in pixels
			allowReuse = true, // Allow tiles to be reused
		} = options;

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
						console.log(
							`Processed ${processed}/${newTileFiles.length} new tiles`
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

		if (tiles.length === 0) {
			throw new Error('No valid tile images could be processed');
		}

		console.log(`Processed ${tiles.length} valid tiles`);

		// Calculate mosaic dimensions
		const aspectRatio = inputMetadata.height / inputMetadata.width;
		const finalMosaicHeight =
			mosaicHeight || Math.round(mosaicWidth * aspectRatio);

		// Resize input image to mosaic grid size for color analysis
		console.log('Analyzing input image colors...');
		const { data: inputData } = await sharp(inputImagePath)
			.resize(mosaicWidth, finalMosaicHeight)
			.raw()
			.toBuffer({ resolveWithObject: true });

		console.log(`Generating ${mosaicWidth}x${finalMosaicHeight} mosaic...`);

		const usedTiles = new Set();
		const tileImages = [];

		// Generate mosaic tile by tile
		for (let y = 0; y < finalMosaicHeight; y++) {
			const row = [];
			for (let x = 0; x < mosaicWidth; x++) {
				// Get color of this pixel in the scaled input image
				const pixelIndex = (y * mosaicWidth + x) * 3;
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

			// Progress indicator
			if ((y + 1) % 10 === 0 || y === finalMosaicHeight - 1) {
				console.log(
					`Progress: ${Math.round(((y + 1) / finalMosaicHeight) * 100)}%`
				);
			}
		}

		console.log(
			`Compositing final ${mosaicWidth} x ${finalMosaicHeight} mosaic...`
		);

		// Create final mosaic more efficiently by processing row by row
		const finalWidth = mosaicWidth * tileSize;
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
			for (let x = 0; x < mosaicWidth; x++) {
				const tilePath = tileImages[y][x];
				const tileBuffer = await sharp(tilePath)
					.resize(tileSize, tileSize)
					.raw()
					.toBuffer();
				tileBuffers.push(tileBuffer);
			}

			// Combine tiles horizontally to create a row
			const rowWidth = mosaicWidth * tileSize;
			const rowHeight = tileSize;
			const rowBuffer = Buffer.alloc(rowWidth * rowHeight * 3);

			for (let x = 0; x < mosaicWidth; x++) {
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
			`Tiles used: ${mosaicWidth}x${finalMosaicHeight} = ${
				mosaicWidth * finalMosaicHeight
			} total`
		);

		return {
			width: finalWidth,
			height: finalHeight,
			tilesUsed: mosaicWidth * finalMosaicHeight,
			availableTiles: tiles.length,
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
			`  --width <number>      Number of tiles horizontally (default: ${defaultMosaicWidth})`
		);
		console.log(
			'  --height <number>     Number of tiles vertically (auto if not specified)'
		);
		console.log(
			`  --tile-size <number>  Size of each tile in pixels (default: ${defaultTileSize})`
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
			'  node main.cjs photo.jpg ./tiles output.png --width 150 --tile-size 24'
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
		mosaicWidth: defaultMosaicWidth,
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
			case '--width':
				options.mosaicWidth = parseInt(args[++i]);
				break;
			case '--height':
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
