import 'package:flutter/material.dart';

import '../phone_session.dart';
import '../theme.dart';

/// Centers [child] and caps its width so wide screens don't stretch content.
class ContentWidth extends StatelessWidget {
  const ContentWidth({super.key, required this.child, this.maxWidth = 1200, this.padding = EdgeInsets.zero});
  final Widget child;
  final double maxWidth;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: maxWidth + padding.horizontal),
          child: Padding(padding: padding, child: child),
        ),
      );
}

class SectionCard extends StatelessWidget {
  const SectionCard({super.key, required this.icon, required this.title, this.subtitle, required this.child, this.trailing});
  final IconData icon;
  final String title;
  final String? subtitle;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: t.colorScheme.primaryContainer.withValues(alpha: 0.6),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(icon, size: 20, color: t.colorScheme.onPrimaryContainer),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                      if (subtitle != null)
                        Text(subtitle!, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                    ],
                  ),
                ),
                ?trailing,
              ],
            ),
            const SizedBox(height: 18),
            child,
          ],
        ),
      ),
    );
  }
}

/// Lays fields out in as many columns as fit (min [minFieldWidth] each).
class ResponsiveFields extends StatelessWidget {
  const ResponsiveFields({super.key, required this.children, this.minFieldWidth = 260, this.maxColumns = 2});
  final List<Widget> children;
  final double minFieldWidth;
  final int maxColumns;

  @override
  Widget build(BuildContext context) {
    const gap = 14.0;
    return LayoutBuilder(builder: (context, c) {
      final cols = ((c.maxWidth + gap) / (minFieldWidth + gap)).floor().clamp(1, maxColumns);
      final w = (c.maxWidth - gap * (cols - 1)) / cols;
      return Wrap(
        spacing: gap,
        runSpacing: gap,
        children: [for (final child in children) SizedBox(width: w, child: child)],
      );
    });
  }
}

class StatusTile extends StatelessWidget {
  const StatusTile({super.key, required this.icon, required this.label, required this.value, this.tone});
  final IconData icon;
  final String label;
  final String value;
  final Tone? tone;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final color = tone == null ? t.colorScheme.onSurface : context.toneColor(tone!);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: t.colorScheme.surfaceContainerHighest.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Icon(icon, size: 22, color: tone == null ? t.colorScheme.onSurfaceVariant : color),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                const SizedBox(height: 2),
                Text(value.isEmpty ? '–' : value,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: t.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600, color: color)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class MessageBanner extends StatelessWidget {
  const MessageBanner({super.key, required this.message, this.onClose});
  final SessionMessage message;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final color = context.toneColor(message.tone);
    final icon = switch (message.tone) {
      Tone.success => Icons.check_circle_outline,
      Tone.warning => Icons.warning_amber_rounded,
      Tone.error => Icons.error_outline,
      Tone.info => Icons.info_outline,
    };
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 200),
      child: Container(
        key: ValueKey(message.text),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.10),
          border: Border.all(color: color.withValues(alpha: 0.35)),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Row(
          children: [
            Icon(icon, color: color, size: 20),
            const SizedBox(width: 10),
            Expanded(child: Text(message.text, style: TextStyle(color: color, fontWeight: FontWeight.w500))),
            if (onClose != null)
              IconButton(
                visualDensity: VisualDensity.compact,
                onPressed: onClose,
                icon: Icon(Icons.close, size: 18, color: color),
              ),
          ],
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.body, this.action, this.loading = false});
  final IconData icon;
  final String title;
  final String? body;
  final Widget? action;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 40),
        child: Column(
          children: [
            Stack(
              alignment: Alignment.center,
              children: [
                if (loading) const SizedBox(width: 84, height: 84, child: CircularProgressIndicator(strokeWidth: 2)),
                CircleAvatar(
                  radius: 34,
                  backgroundColor: t.colorScheme.primaryContainer.withValues(alpha: 0.6),
                  child: Icon(icon, size: 34, color: t.colorScheme.onPrimaryContainer),
                ),
              ],
            ),
            const SizedBox(height: 18),
            Text(title, textAlign: TextAlign.center, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
            if (body != null) ...[
              const SizedBox(height: 8),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Text(body!,
                    textAlign: TextAlign.center,
                    style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              ),
            ],
            if (action != null) ...[const SizedBox(height: 20), action!],
          ],
        ),
      ),
    );
  }
}

/// Four-bar signal indicator for an RSSI value in dBm.
class SignalBars extends StatelessWidget {
  const SignalBars({super.key, required this.rssi});
  final int rssi;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final level = rssi >= -60 ? 4 : rssi >= -70 ? 3 : rssi >= -80 ? 2 : 1;
    return Tooltip(
      message: '$rssi dBm',
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          for (var i = 1; i <= 4; i++)
            Container(
              margin: const EdgeInsets.only(left: 3),
              width: 5,
              height: 6.0 + i * 4,
              decoration: BoxDecoration(
                color: i <= level ? t.colorScheme.primary : t.colorScheme.outlineVariant,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
        ],
      ),
    );
  }
}
