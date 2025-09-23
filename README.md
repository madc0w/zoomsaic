# Zoomsaic - Image Mosaic Generator

A Node.js application that creates beautiful mosaic images by replacing regions of an input image with similar-colored tiles from a collection of images.

## Features

- **Recursive directory scanning**: Automatically finds all images in a directory and its subdirectories
- **Smart color matching**: Uses average color analysis to match tiles to image regions
- **Configurable output**: Adjust mosaic dimensions and tile sizes
- **Multiple formats**: Supports JPG, PNG, GIF, BMP, and WebP images
- **Efficient caching**: Caches tile analysis for better performance
- **Progress tracking**: Shows real-time progress during generation

## Installation

1. Make sure you have Node.js installed (version 14 or higher)
2. Install dependencies:

```bash
npm install
```

## Usage

### Basic Usage

```bash
node main.cjs <input-image> <tiles-directory> <output-image>
```

### Example

```bash
node main.cjs photo.jpg ./my-tiles mosaic-output.png
```

### Advanced Options

```bash
node main.cjs photo.jpg ./tiles output.png --width 150 --tile-size 24
```

### Command Line Options

- `--width <number>`: Number of tiles horizontally (default: 100)
- `--height <number>`: Number of tiles vertically (auto-calculated if not specified)
- `--tile-size <number>`: Size of each tile in pixels (default: 32)
- `--no-reuse`: Don't reuse tiles (may result in lower quality if you have fewer tiles than needed)

## How It Works

1. **Input Analysis**: The input image is analyzed and divided into a grid
2. **Tile Processing**: All images in the tiles directory are processed to calculate their average colors
3. **Color Matching**: For each grid cell in the input image, the algorithm finds the tile with the most similar average color
4. **Mosaic Generation**: The selected tiles are arranged to create the final mosaic image

## Tips for Best Results

- **Tile Collection**: Use a diverse collection of images with varying colors and brightness levels
- **Tile Quality**: Higher resolution tiles generally produce better results
- **Image Size**: Larger mosaics (more tiles) typically look better but take longer to generate
- **Tile Size**: Smaller tile sizes create more detailed mosaics but result in larger output files

## Performance

- The application caches tile analysis results for improved performance on subsequent runs
- Processing time depends on:
  - Number of tiles in your collection
  - Size of the output mosaic
  - System performance

## Example Output Sizes

| Width | Height | Tile Size | Output Resolution |
| ----- | ------ | --------- | ----------------- |
| 100   | 75     | 32px      | 3200 x 2400       |
| 150   | 113    | 24px      | 3600 x 2712       |
| 200   | 150    | 16px      | 3200 x 2400       |

## Supported Image Formats

**Input**: JPG, JPEG, PNG, GIF, BMP, WebP
**Output**: PNG (high quality, lossless)

## Requirements

- Node.js 14+
- Canvas library (automatically installed with npm install)

## Troubleshooting

**"No image files found"**: Make sure your tiles directory contains supported image formats
**Memory issues**: Try reducing the mosaic width/height or tile size for large collections
**Canvas installation issues**: The canvas library requires native dependencies - see [canvas installation guide](https://github.com/Automattic/node-canvas#compiling)

## License

MIT
