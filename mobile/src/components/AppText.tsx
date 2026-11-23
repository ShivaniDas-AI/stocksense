import React from "react";
import { Text as RNText, TextInput as RNTextInput, type TextInputProps, type TextProps } from "react-native";

/**
 * Text and TextInput with the phone's font scaling capped.
 *
 * Many Android phones ship with a larger system font size. Uncapped, every
 * label grows while cards, tiles and the tab bar keep their size, so text
 * spills into its neighbours. Capping at 1.25x keeps text readable for people
 * who enlarge it while the layout still holds.
 */
export const MAX_FONT_SCALE = 1.25;

export const Text = React.forwardRef<React.ElementRef<typeof RNText>, TextProps>((props, ref) => (
  <RNText ref={ref} maxFontSizeMultiplier={MAX_FONT_SCALE} {...props} />
));
Text.displayName = "Text";

export const TextInput = React.forwardRef<React.ElementRef<typeof RNTextInput>, TextInputProps>((props, ref) => (
  <RNTextInput ref={ref} maxFontSizeMultiplier={MAX_FONT_SCALE} {...props} />
));
TextInput.displayName = "TextInput";
