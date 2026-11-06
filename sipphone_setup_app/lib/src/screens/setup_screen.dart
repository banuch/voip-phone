import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../phone_session.dart';
import '../protocol.dart';
import '../theme.dart';
import '../widgets/common.dart';

class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key, required this.session});
  final PhoneSession session;

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  final _form = GlobalKey<FormState>();
  final _ssid = TextEditingController();
  final _wifiPw = TextEditingController();
  final _server = TextEditingController();
  final _port = TextEditingController();
  final _user = TextEditingController();
  final _sipPw = TextEditingController();
  final _authUser = TextEditingController();
  final _domain = TextEditingController();
  final _answerMs = TextEditingController();
  final _expires = TextEditingController();
  final _sipLocal = TextEditingController();
  final _rtpLocal = TextEditingController();
  final _otaPw = TextEditingController();

  bool _openWifi = false;
  bool _otaOff = false;
  bool _autoAnswer = true;
  double _volume = 60;
  double _micGain = 4;
  bool _advanced = false;
  int _filledVersion = -1;

  PhoneSession get s => widget.session;

  @override
  void initState() {
    super.initState();
    s.addListener(_onSession);
    _onSession();
  }

  @override
  void dispose() {
    s.removeListener(_onSession);
    for (final c in [_ssid, _wifiPw, _server, _port, _user, _sipPw, _authUser, _domain, _answerMs, _expires, _sipLocal, _rtpLocal, _otaPw]) {
      c.dispose();
    }
    super.dispose();
  }

  void _onSession() {
    final cfg = s.config;
    if (cfg != null && s.configVersion != _filledVersion) {
      _filledVersion = s.configVersion;
      _fill(cfg);
    }
    if (mounted) setState(() {});
  }

  void _fill(PhoneConfig c) {
    _ssid.text = c.wifiSsid;
    _wifiPw.clear();
    _openWifi = false;
    _server.text = c.sipServer;
    _port.text = '${c.sipServerPort}';
    _user.text = c.sipUser;
    _sipPw.clear();
    _authUser.text = c.sipAuthUser;
    _domain.text = c.sipDomain;
    _autoAnswer = c.autoAnswerMs >= 0;
    _answerMs.text = '${c.autoAnswerMs >= 0 ? c.autoAnswerMs : 1000}';
    _volume = c.speakerVolume.clamp(0, 100).toDouble();
    _micGain = c.micGain.clamp(1, 32).toDouble();
    _expires.text = '${c.sipExpires}';
    _sipLocal.text = '${c.sipLocalPort}';
    _rtpLocal.text = '${c.rtpLocalPort}';
    _otaPw.clear();
    _otaOff = false;
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) {
      // Open "Advanced" if the error is in there, so it is visible.
      if (!_advanced) setState(() => _advanced = true);
      return;
    }
    final values = <String, Object>{
      'wifi_ssid': _ssid.text.trim(),
      'sip_server': _server.text.trim(),
      'sip_server_port': int.parse(_port.text),
      'sip_user': _user.text.trim(),
      'sip_auth_user': _authUser.text.trim(),
      'sip_domain': _domain.text.trim(),
      'auto_answer_ms': _autoAnswer ? int.parse(_answerMs.text) : -1,
      'speaker_volume': _volume.round(),
      'mic_gain': _micGain.round(),
      'sip_expires': int.parse(_expires.text),
      'sip_local_port': int.parse(_sipLocal.text),
      'rtp_local_port': int.parse(_rtpLocal.text),
    };
    if (_openWifi) {
      values['wifi_password'] = '';
    } else if (_wifiPw.text.isNotEmpty) {
      values['wifi_password'] = _wifiPw.text;
    }
    if (_sipPw.text.isNotEmpty) values['sip_password'] = _sipPw.text;
    if (_otaOff) {
      values['ota_password'] = '';
    } else if (_otaPw.text.isNotEmpty) {
      values['ota_password'] = _otaPw.text;
    }
    FocusScope.of(context).unfocus();
    await s.save(values);
  }

  Future<void> _confirm({
    required String title,
    required String body,
    required String action,
    required Future<void> Function() run,
    bool destructive = false,
  }) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            style: destructive
                ? FilledButton.styleFrom(
                    backgroundColor: Theme.of(ctx).colorScheme.error,
                    foregroundColor: Theme.of(ctx).colorScheme.onError,
                  )
                : null,
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(action),
          ),
        ],
      ),
    );
    if (ok == true) await run();
  }

  void _menu(String v) {
    switch (v) {
      case 'reload':
        s.reload();
      case 'reboot':
        _confirm(title: 'Restart phone?', body: 'The phone restarts and reconnects in a few seconds.', action: 'Restart', run: s.reboot);
      case 'reset':
        _confirm(
          title: 'Factory reset?',
          body: 'This erases all saved Wi-Fi, SIP and audio settings on the phone.',
          action: 'Erase',
          destructive: true,
          run: s.factoryReset,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final size = windowSizeOf(context);
    final wide = size == WindowSize.expanded;
    final pad = size == WindowSize.compact ? 16.0 : 24.0;
    final editable = s.isReady && !s.busy;

    final form = Form(
      key: _form,
      autovalidateMode: AutovalidateMode.onUserInteraction,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _wifiSection(editable),
          const SizedBox(height: 16),
          _sipSection(editable),
          const SizedBox(height: 16),
          _audioSection(editable),
          const SizedBox(height: 16),
          _updateSection(editable),
          const SizedBox(height: 16),
          _advancedSection(editable),
          const SizedBox(height: 12),
          Text(
            'Leave a password empty to keep the saved one. Passwords are never read back from the phone.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
          ),
        ],
      ),
    );

    final Widget body;
    if (wide) {
      body = ContentWidth(
        maxWidth: 1240,
        padding: EdgeInsets.symmetric(horizontal: pad),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 360,
              child: SingleChildScrollView(
                padding: const EdgeInsets.only(top: 8, bottom: 24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    ..._messageAndStatus(),
                    const SizedBox(height: 16),
                    _actionsCard(editable),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 24),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.only(top: 8, bottom: 24),
                child: form,
              ),
            ),
          ],
        ),
      );
    } else {
      body = SingleChildScrollView(
        child: ContentWidth(
          maxWidth: 760,
          padding: EdgeInsets.fromLTRB(pad, 8, pad, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [..._messageAndStatus(), const SizedBox(height: 16), form],
          ),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(s.name),
            _ConnectionChip(state: s.state),
          ],
        ),
        toolbarHeight: 68,
        actions: [
          if (s.state == SessionState.disconnected)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: TextButton.icon(
                onPressed: () => s.connect().catchError((_) {}),
                icon: const Icon(Icons.bluetooth_connected),
                label: const Text('Reconnect'),
              ),
            ),
          if (!wide)
            PopupMenuButton<String>(
              enabled: editable,
              onSelected: _menu,
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'reload', child: ListTile(leading: Icon(Icons.sync), title: Text('Reload from phone'))),
                PopupMenuItem(value: 'reboot', child: ListTile(leading: Icon(Icons.restart_alt), title: Text('Restart phone'))),
                PopupMenuDivider(),
                PopupMenuItem(value: 'reset', child: ListTile(leading: Icon(Icons.delete_forever_outlined), title: Text('Factory reset'))),
              ],
            ),
          const SizedBox(width: 8),
        ],
      ),
      body: SafeArea(top: false, bottom: wide, child: body),
      bottomNavigationBar: wide ? null : _saveBar(editable, pad),
    );
  }

  List<Widget> _messageAndStatus() => [
        if (s.message != null) ...[MessageBanner(message: s.message!), const SizedBox(height: 16)],
        _StatusCard(status: s.status, restarting: s.state == SessionState.restarting),
      ];

  Widget _saveButton(bool editable) => FilledButton.icon(
        onPressed: editable ? _save : null,
        icon: s.busy
            ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
            : const Icon(Icons.save_outlined),
        label: const Text('Save and restart'),
      );

  Widget _saveBar(bool editable, double pad) {
    final t = Theme.of(context);
    return Material(
      color: t.cardTheme.color,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: ContentWidth(
          maxWidth: 760,
          padding: EdgeInsets.fromLTRB(pad, 12, pad, 12),
          child: _saveButton(editable),
        ),
      ),
    );
  }

  Widget _actionsCard(bool editable) => SectionCard(
        icon: Icons.tune,
        title: 'Actions',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _saveButton(editable),
            const SizedBox(height: 10),
            OutlinedButton.icon(onPressed: editable ? () => _menu('reload') : null, icon: const Icon(Icons.sync), label: const Text('Reload from phone')),
            const SizedBox(height: 10),
            OutlinedButton.icon(onPressed: editable ? () => _menu('reboot') : null, icon: const Icon(Icons.restart_alt), label: const Text('Restart phone')),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: editable ? () => _menu('reset') : null,
              style: OutlinedButton.styleFrom(
                foregroundColor: context.toneColor(Tone.error),
                side: BorderSide(color: context.toneColor(Tone.error).withValues(alpha: 0.5)),
              ),
              icon: const Icon(Icons.delete_forever_outlined),
              label: const Text('Factory reset'),
            ),
          ],
        ),
      );

  // ---- sections ----

  Widget _wifiSection(bool enabled) {
    final cfg = s.config;
    return SectionCard(
      icon: Icons.wifi,
      title: 'Wi-Fi',
      subtitle: '2.4 GHz networks only',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ResponsiveFields(children: [
            _text(_ssid, 'Network name (SSID)', enabled: enabled, maxLength: 32, required: true, icon: Icons.router_outlined),
            _PasswordField(
              controller: _wifiPw,
              label: 'Password',
              enabled: enabled && !_openWifi,
              helper: _openWifi
                  ? 'Open network'
                  : cfg?.wifiPasswordSet == true
                      ? 'Saved. Leave empty to keep it.'
                      : 'Not set',
              maxLength: 63,
              validator: (v) {
                if (_openWifi || v == null || v.isEmpty) return null;
                if (v.length < 8) return 'At least 8 characters';
                return null;
              },
            ),
          ]),
          const SizedBox(height: 4),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _openWifi,
            onChanged: enabled ? (v) => setState(() => _openWifi = v) : null,
            title: const Text('Open network (no password)'),
          ),
        ],
      ),
    );
  }

  Widget _sipSection(bool enabled) {
    final cfg = s.config;
    return SectionCard(
      icon: Icons.dialer_sip_outlined,
      title: 'SIP account',
      subtitle: 'Must match the endpoint on your SIP server',
      child: ResponsiveFields(children: [
        _text(_server, 'Server (IP or hostname)', enabled: enabled, maxLength: 64, required: true, hint: '192.168.1.50', icon: Icons.dns_outlined),
        _number(_port, 'Server port', enabled: enabled, min: 1, max: 65535),
        _text(_user, 'Extension / user', enabled: enabled, maxLength: 32, required: true, hint: '1001', icon: Icons.person_outline),
        _PasswordField(
          controller: _sipPw,
          label: 'Password',
          enabled: enabled,
          maxLength: 64,
          helper: cfg?.sipPasswordSet == true ? 'Saved. Leave empty to keep it.' : 'Not set',
        ),
        _text(_authUser, 'Auth user (optional)', enabled: enabled, maxLength: 32, hint: 'Same as extension'),
        _text(_domain, 'Domain (optional)', enabled: enabled, maxLength: 64, hint: 'Same as server'),
      ]),
    );
  }

  Widget _updateSection(bool enabled) {
    final cfg = s.config;
    final t = Theme.of(context);
    final url = s.status?.otaUrl ?? '';
    return SectionCard(
      icon: Icons.system_update_alt,
      title: 'Firmware update over Wi-Fi',
      subtitle: 'Upload a new .bin from a browser on the same network',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ResponsiveFields(children: [
            _PasswordField(
              controller: _otaPw,
              label: 'Update password',
              enabled: enabled && !_otaOff,
              maxLength: 64,
              helper: _otaOff
                  ? 'Updates will be turned off'
                  : cfg?.otaPasswordSet == true
                      ? 'Saved: updates on. Leave empty to keep it.'
                      : 'Not set: updates off',
              validator: (v) {
                if (_otaOff || v == null || v.isEmpty) return null;
                if (v.length < 8) return 'At least 8 characters';
                return null;
              },
            ),
          ]),
          const SizedBox(height: 4),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _otaOff,
            onChanged: enabled && cfg?.otaPasswordSet == true ? (v) => setState(() => _otaOff = v) : null,
            title: const Text('Turn off updates over Wi-Fi'),
          ),
          const SizedBox(height: 4),
          SelectableText(
            url.isNotEmpty
                ? 'Update page: $url (user admin)'
                : 'With a password set, open http://<phone IP>/update in a browser (user admin).',
            style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }

  Widget _audioSection(bool enabled) {
    final t = Theme.of(context);
    return SectionCard(
      icon: Icons.volume_up_outlined,
      title: 'Call and audio',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _autoAnswer,
            onChanged: enabled ? (v) => setState(() => _autoAnswer = v) : null,
            title: const Text('Answer calls automatically'),
            subtitle: const Text('Off: answer with the BOOT button only'),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 200),
            child: _autoAnswer
                ? Padding(
                    padding: const EdgeInsets.only(top: 8, bottom: 8),
                    child: ResponsiveFields(children: [
                      _number(_answerMs, 'Answer after (ms)', enabled: enabled, min: 0, max: 60000, icon: Icons.timer_outlined),
                    ]),
                  )
                : const SizedBox(width: double.infinity),
          ),
          const SizedBox(height: 8),
          LayoutBuilder(builder: (context, c) {
            final sliders = [
              _slider('Speaker volume', Icons.volume_up, _volume, 0, 100, '${_volume.round()} %', enabled,
                  (v) => setState(() => _volume = v)),
              _slider('Mic gain', Icons.mic_none, _micGain, 1, 32, '×${_micGain.round()}', enabled,
                  (v) => setState(() => _micGain = v)),
            ];
            if (c.maxWidth < 560) return Column(children: sliders);
            return Row(children: [Expanded(child: sliders[0]), const SizedBox(width: 24), Expanded(child: sliders[1])]);
          }),
          Text('Volume and gain also change from the serial console (+ / -).',
              style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
        ],
      ),
    );
  }

  Widget _advancedSection(bool enabled) => Card(
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            InkWell(
              onTap: () => setState(() => _advanced = !_advanced),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 12, 16),
                child: Row(
                  children: [
                    Icon(Icons.settings_ethernet, color: Theme.of(context).colorScheme.onSurfaceVariant),
                    const SizedBox(width: 12),
                    Expanded(child: Text('Advanced', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
                    AnimatedRotation(
                      turns: _advanced ? 0.5 : 0,
                      duration: const Duration(milliseconds: 200),
                      child: const Icon(Icons.expand_more),
                    ),
                  ],
                ),
              ),
            ),
            // Kept in the tree (just hidden) so its validators still run on save.
            AnimatedCrossFade(
              duration: const Duration(milliseconds: 200),
              crossFadeState: _advanced ? CrossFadeState.showSecond : CrossFadeState.showFirst,
              firstChild: const SizedBox(width: double.infinity),
              secondChild: Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
                child: ResponsiveFields(maxColumns: 3, minFieldWidth: 180, children: [
                  _number(_expires, 'Registration expiry (s)', enabled: enabled, min: 60, max: 86400),
                  _number(_sipLocal, 'Local SIP port', enabled: enabled, min: 1, max: 65535,
                      extra: (v) => v == int.tryParse(_rtpLocal.text) ? 'Must differ from RTP port' : null),
                  _number(_rtpLocal, 'Local RTP port', enabled: enabled, min: 1, max: 65535,
                      extra: (v) => v == int.tryParse(_sipLocal.text) ? 'Must differ from SIP port' : null),
                ]),
              ),
            ),
          ],
        ),
      );

  // ---- field builders ----

  Widget _text(TextEditingController c, String label,
      {required bool enabled, int? maxLength, bool required = false, String? hint, IconData? icon}) {
    return TextFormField(
      controller: c,
      enabled: enabled,
      autocorrect: false,
      enableSuggestions: false,
      inputFormatters: [if (maxLength != null) LengthLimitingTextInputFormatter(maxLength)],
      decoration: InputDecoration(labelText: label, hintText: hint, prefixIcon: icon == null ? null : Icon(icon)),
      validator: (v) => required && (v == null || v.trim().isEmpty) ? 'Required' : null,
    );
  }

  Widget _number(TextEditingController c, String label,
      {required bool enabled, required int min, required int max, IconData? icon, String? Function(int)? extra}) {
    return TextFormField(
      controller: c,
      enabled: enabled,
      keyboardType: TextInputType.number,
      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
      decoration: InputDecoration(labelText: label, prefixIcon: icon == null ? null : Icon(icon)),
      validator: (v) {
        final n = int.tryParse(v ?? '');
        if (n == null) return 'Required';
        if (n < min || n > max) return '$min – $max';
        return extra?.call(n);
      },
    );
  }

  Widget _slider(String label, IconData icon, double value, double min, double max, String display, bool enabled,
      ValueChanged<double> onChanged) {
    final t = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(icon, size: 18, color: t.colorScheme.onSurfaceVariant),
            const SizedBox(width: 8),
            Expanded(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: t.textTheme.bodyMedium)),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
              decoration: BoxDecoration(color: t.colorScheme.primaryContainer, borderRadius: BorderRadius.circular(20)),
              child: Text(display, style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.onPrimaryContainer, fontWeight: FontWeight.w600)),
            ),
          ],
        ),
        Slider(
          value: value,
          min: min,
          max: max,
          divisions: (max - min).round(),
          onChanged: enabled ? onChanged : null,
        ),
      ],
    );
  }
}

class _PasswordField extends StatefulWidget {
  const _PasswordField({
    required this.controller,
    required this.label,
    required this.enabled,
    required this.helper,
    required this.maxLength,
    this.validator,
  });
  final TextEditingController controller;
  final String label;
  final bool enabled;
  final String helper;
  final int maxLength;
  final FormFieldValidator<String>? validator;

  @override
  State<_PasswordField> createState() => _PasswordFieldState();
}

class _PasswordFieldState extends State<_PasswordField> {
  bool _show = false;

  @override
  Widget build(BuildContext context) => TextFormField(
        controller: widget.controller,
        enabled: widget.enabled,
        obscureText: !_show,
        autocorrect: false,
        enableSuggestions: false,
        inputFormatters: [LengthLimitingTextInputFormatter(widget.maxLength)],
        validator: widget.validator,
        decoration: InputDecoration(
          labelText: widget.label,
          helperText: widget.helper,
          prefixIcon: const Icon(Icons.lock_outline),
          suffixIcon: IconButton(
            tooltip: _show ? 'Hide' : 'Show',
            onPressed: () => setState(() => _show = !_show),
            icon: Icon(_show ? Icons.visibility_off_outlined : Icons.visibility_outlined),
          ),
        ),
      );
}

class _ConnectionChip extends StatelessWidget {
  const _ConnectionChip({required this.state});
  final SessionState state;

  @override
  Widget build(BuildContext context) {
    final (text, tone) = switch (state) {
      SessionState.ready => ('Connected', Tone.success),
      SessionState.connecting => ('Connecting...', Tone.info),
      SessionState.restarting => ('Phone restarting...', Tone.warning),
      SessionState.disconnected => ('Disconnected', Tone.error),
    };
    final color = context.toneColor(tone);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(width: 8, height: 8, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
        const SizedBox(width: 6),
        Text(text, style: Theme.of(context).textTheme.labelMedium?.copyWith(color: color)),
      ],
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.status, required this.restarting});
  final PhoneStatus? status;
  final bool restarting;

  @override
  Widget build(BuildContext context) {
    final st = status;
    final wifiTone = st == null
        ? null
        : st.wifiUp
            ? Tone.success
            : st.wifi == 'not set'
                ? Tone.error
                : Tone.warning;
    final sipTone = st == null
        ? null
        : st.sipUp
            ? Tone.success
            : st.configured
                ? Tone.warning
                : Tone.error;
    final tiles = [
      StatusTile(
        icon: Icons.wifi,
        label: 'Wi-Fi',
        value: st == null ? '' : '${st.wifi}${st.rssi != 0 ? ' · ${st.rssi} dBm' : ''}',
        tone: wifiTone,
      ),
      StatusTile(icon: Icons.lan_outlined, label: 'IP address', value: st?.ip ?? ''),
      StatusTile(icon: Icons.dialer_sip_outlined, label: 'SIP', value: st?.sip ?? '', tone: sipTone),
      StatusTile(icon: Icons.call_outlined, label: 'Call', value: st?.call ?? ''),
      StatusTile(icon: Icons.memory_outlined, label: 'Firmware', value: st?.fw ?? ''),
    ];
    final t = Theme.of(context);
    return SectionCard(
      icon: Icons.monitor_heart_outlined,
      title: 'Phone status',
      subtitle: restarting ? 'Waiting for the phone to come back...' : 'Live from the phone',
      trailing: restarting ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ResponsiveFields(minFieldWidth: 150, maxColumns: 2, children: tiles),
          if (st != null && st.sipDetail.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text('SIP: ${st.sipDetail}', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
          ],
        ],
      ),
    );
  }
}
