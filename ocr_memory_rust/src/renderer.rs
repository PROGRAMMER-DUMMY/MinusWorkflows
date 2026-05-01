use image::{Rgb, RgbImage, ImageOutputFormat};
use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use std::io::Cursor;
use std::path::Path;

pub struct TrajectoryRenderer;

impl TrajectoryRenderer {
    pub fn new() -> Self {
        Self
    }

    /// Renders text segments with numbered red boxes (SoM) onto a PNG image.
    /// Supports dynamic resolutions like (1024, 1024), (768, 768), or (512, 512).
    pub fn render_trajectory(&self, segments: Vec<String>, resolution: (u32, u32)) -> Vec<u8> {
        let (width, height) = resolution;
        let mut img = RgbImage::new(width, height);

        // Fill background white
        for pixel in img.pixels_mut() {
            *pixel = Rgb([255, 255, 255]);
        }

        // Load font - fallback to a few common paths if one fails
        let font_paths = [
            "C:\\Windows\\Fonts\\arial.ttf",
            "C:\\Windows\\Fonts\\segoeui.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ];

        let mut font_data = Vec::new();
        for path in &font_paths {
            if Path::new(path).exists() {
                if let Ok(data) = std::fs::read(path) {
                    font_data = data;
                    break;
                }
            }
        }

        if font_data.is_empty() {
            // If no font found, we can't render text properly with ab_glyph
            // In a real app, we might bundle a font or return an error
            panic!("No system font found for rendering. Please ensure arial.ttf or similar is available.");
        }

        let font = FontRef::try_from_slice(&font_data).expect("Failed to load font");

        let box_color = Rgb([255, 0, 0]);
        let text_color_white = Rgb([255, 255, 255]);
        let text_color_black = Rgb([0, 0, 0]);
        
        // Dynamic font size based on resolution
        let font_size = if width >= 1024 { 36.0 } else if width >= 768 { 28.0 } else { 20.0 };
        let scale = PxScale::from(font_size);

        let mut y_offset = 20u32;
        let box_height = (font_size * 2.5) as u32;
        let box_margin = 20u32;
        let thickness = 3u32;

        for (i, text) in segments.iter().enumerate() {
            let idx = i + 1;
            
            // Draw main bounding box
            let box_x = box_margin;
            let box_y = y_offset;
            let box_w = width - 2 * box_margin;
            let box_h = box_height;
            
            self.draw_rect(&mut img, box_x, box_y, box_w, box_h, box_color, thickness);

            // Draw index label box (filled red)
            let label_w = (font_size * 1.5) as u32;
            let label_h = (font_size * 1.2) as u32;
            self.draw_filled_rect(&mut img, box_x, box_y, label_w, label_h, box_color);

            // Draw index text (white)
            self.draw_text(&mut img, &font, &idx.to_string(), (box_x + 5) as f32, (box_y + 2) as f32, scale, text_color_white);

            // Draw segment text (black, simple truncation for now)
            let max_chars = (box_w / (font_size * 0.6) as u32) as usize;
            let display_text = if text.len() > max_chars { &text[..max_chars] } else { text };
            self.draw_text(&mut img, &font, display_text, (box_x + label_w + 10) as f32, (box_y + 5) as f32, scale, text_color_black);

            y_offset += box_height + 20;
            if y_offset + box_height > height {
                break; // Stop if we run out of space
            }
        }

        let mut bytes: Vec<u8> = Vec::new();
        img.write_to(&mut Cursor::new(&mut bytes), ImageOutputFormat::Png).expect("Failed to encode PNG");
        bytes
    }

    fn draw_rect(&self, img: &mut RgbImage, x: u32, y: u32, w: u32, h: u32, color: Rgb<u8>, thickness: u32) {
        for t in 0..thickness {
            // Top and bottom
            for xi in x..(x + w) {
                if xi < img.width() {
                    if y + t < img.height() { img.put_pixel(xi, y + t, color); }
                    if y + h - 1 - t < img.height() { img.put_pixel(xi, y + h - 1 - t, color); }
                }
            }
            // Left and right
            for yi in y..(y + h) {
                if yi < img.height() {
                    if x + t < img.width() { img.put_pixel(x + t, yi, color); }
                    if x + w - 1 - t < img.width() { img.put_pixel(x + w - 1, yi, color); }
                }
            }
        }
    }

    fn draw_filled_rect(&self, img: &mut RgbImage, x: u32, y: u32, w: u32, h: u32, color: Rgb<u8>) {
        for xi in x..(x + w) {
            for yi in y..(y + h) {
                if xi < img.width() && yi < img.height() {
                    img.put_pixel(xi, yi, color);
                }
            }
        }
    }

    fn draw_text(&self, img: &mut RgbImage, font: &FontRef, text: &str, x: f32, y: f32, scale: PxScale, color: Rgb<u8>) {
        let scaled_font = font.as_scaled(scale);
        let mut x_pos = x;
        for c in text.chars() {
            let glyph = scaled_font.scaled_glyph(c);
            let glyph = glyph.positioned(ab_glyph::point(x_pos, y + scaled_font.ascent()));
            if let Some(outline) = font.outline_glyph(glyph) {
                let bounds = outline.px_bounds();
                outline.draw(|gx, gy, gv| {
                    let px = (bounds.min.x + gx as f32) as u32;
                    let py = (bounds.min.y + gy as f32) as u32;
                    if px < img.width() && py < img.height() {
                        let pixel = img.get_pixel_mut(px, py);
                        let alpha = gv;
                        *pixel = Rgb([
                            ((1.0 - alpha) * pixel[0] as f32 + alpha * color[0] as f32) as u8,
                            ((1.0 - alpha) * pixel[1] as f32 + alpha * color[1] as f32) as u8,
                            ((1.0 - alpha) * pixel[2] as f32 + alpha * color[2] as f32) as u8,
                        ]);
                    }
                });
            }
            x_pos += scaled_font.h_advance(font.glyph_id(c));
        }
    }
}
