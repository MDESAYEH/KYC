# تنفيذ Resume المحلي — 19 نوفمبر 2026

الحالة: مكونات التنفيذ جاهزة للاختبار والمراجعة، دون ربط بمُرسل REIS حقيقي أو إضافة أمر Apply. هذا العمل لا يجيز النشر أو التنفيذ على البنك. يكمل [مراجعة التصميم](single-kyc-resume-review.md)، ولا يعيد تفسير الأدلة التاريخية تلقائيًا.

## النطاق الثابت

CIF `00005804`، KYC `001ZKYC26151003Y`، CIF MOD_NO وSEQ_NO كلاهما **1**. لا MAX+1 ولا إنشاء مراجعة جديدة. البداية المطلوبة E/E مع REQUEST وRESPONSE وقرار نهائي NULL، KYC مفتوح، ولا صف أعلى SEQ_NO. أي اختلاف يرفض الاستكمال.

نجاح المصادقة HTTP200 إفادة مؤكدة من المستخدم، ولم نكرر الاختبار على REIS. لا يثبت ذلك غياب Onboarding من المحاولتين؛ ما زالت وثيقة REIS المستقلة مطلوبة لتأكيد عدم الإنشاء **وعدم المعالجة لكلتيهما**.

## ما أصبح منفذًا

| المكوّن | السلوك |
|---|---|
| `ResumeJournal` | سجل SQLite دائم للمحاولات والأحداث؛ يستعمل نفس ملف قاعدة التطبيق الذي يحتوي webhook_event؛ معاملات IMMEDIATE وsynchronous=FULL؛ UPDATE/DELETE ممنوعان على المحاولات والأحداث والحجز بواسطة triggers |
| سجل التاريخ | استيراد محاولتين بالمعرف والمحتوى الأصلي وبصمته؛ إعادة استخدام معرف تاريخي بمحتوى مختلف مرفوضة؛ snapshot المحاولة الجديدة والموافقة مثبتان قبل أول كتابة Oracle؛ لا حذف local case أو webhook audit |
| الحجز المحلي | مفتاح فريد دائم CIF/KYC/SEQ؛ لا release أو lease أو إعادة فتح عند الانقطاع أو فشل auth؛ يبقى بعد إغلاق/فتح قاعدة SQLite أو إعادة تشغيل العملية |
| إيصال Oracle | مفتاح فريد لنفس النطاق؛ حفظ ORIGINAL_SNAPSHOT قبل تغيير staging، ثم CLAIMED/DISPATCH/COMPLETED snapshots؛ حماية DDL منفصلة تمنع حذف الإيصال وتغيير الأصل أو إرجاع phase للخلف |
| Oracle adapter | معاملات على اتصال واحد؛ قفل CUSTOMER ثم KYC master ثم staging ثم trigger وreceipt؛ فحص كامل للحالة المحفوظة تحت القفل ثم UPDATE بشروط KYC/SEQ/MSGID/status؛ رفض drift؛ لا reset ولا restoreNeverSent |
| بوابة dispatch | فحص STOP عبر port قبل الحجز وبعد auth وقبل dispatch، ومراجعة صلاحية الموافقة وتأكيد REIS، وتطابق payload المعاد تحميله، وحالة Oracle وMOD_NO والـcallback audit؛ تثبيت DISPATCH_INTENT لمرة واحدة قبل استدعاء port |
| الرد والـwriteback | حفظ wire قبل parse، اشتقاق CLEAN/PENDING/BLOCKED من body الحقيقي فقط، ثم كتابة Oracle والتحقق من S والقرار وtrigger=P، ثم projection للحالة المحلية مع CAS؛ استكمال writeback من الرد المحفوظ لا يصل إلى authenticate أو dispatch |
| Callback | كلا systemId القديم وCIF لهذه الحالة محجوران دائمًا قبل lookup/apply؛ لا اعتماد على revision_count=1 أو أحدث case؛ كل حدث يُدقق، بما فيه المتأخر والمكرر والمتعارض؛ لا ادعاء حل correlation الذي لا يوفره REIS |
| Preflight | قراءة export محلي ونسخة SQLite بوضع readonly فقط؛ لا .env ولا شبكة ولا migrations؛ يعرض شروط الحالة وأثر callbacks والحجز وبصمات الأدلة والتأكيد، ويرفض --apply و--confirm |

`DISPATCHED` في Oracle و`DISPATCH_INTENT` في SQLite يعنيان **نية إرسال مثبتة** وليسا إثبات وصول الطلب. عند الشك لا يُعاد الاستدعاء. الحجز ليس ضمان idempotency من REIS؛ هو منع تكرار من هذا المسار، ويتطلب إيقاف بقية المرسلين.

بعد فشل معروف قبل Onboarding أو فشل غير مؤكد، يسجل journal الحدث والمرحلة دون مسح الأصل. قد يبقى Oracle على W وtrigger=P، لأننا لا نعيد حالة ملتزمة عبر قاعدة أخرى تلقائيًا. هذه حالة مصالحة موثقة، وليست نجاحًا أو إذن إرسال جديد. لا يُكتب CLEAN لمعالجة هذا التعليق.

التوكن لا يدخل journal أو ملفات الأدلة أو stdout. بيانات العميل والـwire محفوظة في قاعدة محمية وreport محمي فقط؛ ملفات report جديدة حصريًا بصلاحية POSIX 0600، وتحتاج المجلدات على Windows إلى ACL مناسب. الـhash يكشف التلف ولا يثبت هوية الموافق أو أصالة وثيقة REIS؛ يلزم تحقق تشغيلي مستقل.

## انتقالات الفشل

| نقطة الفشل | ما يبقى محفوظًا | الإجراء المسموح برمجيًا |
|---|---|---|
| فشل إثبات الأدلة أو الموافقة قبل الحجز | لا تغييرات ولا auth | Preflight جديد بعد استكمال الأدلة |
| التزام SQLite ثم تعذر Oracle أو فقدان ACK للـcommit | الحجز المحلي والأصل؛ وقد يوجد إيصال Oracle | مصالحة وقراءة فقط؛ لا execute جديد |
| authenticate أو STOP أو انتهاء الموافقة أو تغير المصدر قبل dispatch | FAILED_BEFORE_ONBOARDING مع phase؛ الحجز لا يُحرر | لا إرسال تلقائي |
| وصول Callback قبل تثبيت dispatch intent | audit دائم وحجر؛ dispatch مرفوض | مصالحة مستقلة |
| فقد الرد/timeout بعد dispatch intent أو تعذر حفظ wire | DELIVERY_UNCERTAIN، intent دائم، لا قرار مختلق | لا إرسال تلقائي ولا writeback بلا رد دائم صالح |
| wire غير صالح أو non-2xx | الرد الأصلي محفوظ، DELIVERY_UNCERTAIN | مصالحة؛ لا CLEAN |
| حفظ wire صالح ثم انقطاع أو فشل UPDATE Oracle | RESPONSE_CAPTURED وWRITEBACK_PENDING | recoverWriteback داخليًا من نفس wire فقط، بعد التحقق من المراجعة والإيصال |
| التزام Oracle وفشل projection المحلي | إيصال COMPLETED وwire دائم | تكرار writeback يؤكد نفس snapshot ثم يكمل SQLite فقط |
| تغير MOD_NO أو أي جزء من snapshot | رفض CAS مع بقاء الأدلة والحجز | لا كتابة للنسخة الجديدة ولا MAX+1 |

## Oracle المعزول الحقيقي

شُغلت حاوية مشروع Docker المخصص `kyc-resume-isolated` من compose الموجود بالمشروع، loopback فقط، مستخدم `KYC_TEST` وكلمات مرور وهمية من ملف الاختبار. لم تُستخدم `.env` أو بيانات اعتماد البنك. الصورة المسماة `gvenzl/oracle-free:23-slim-faststart` أبلغت فعليًا عن Oracle AI Database 26ai Free / 23.26.4.0.0؛ ليست مطابقة مثبتة لإصدار/DDL البنك.

منعت بوابة الاختبار الاتصال بأي host غير loopback، أو مستخدم بنك، أو قاعدة تحمل أسماء UAT/PROD/FLEXCUBE أو جداول STTM/FLTM/CSTM. أُنشئت جداول fixture عشوائية KRR_* فقط وأُسقطت بعد الاختبارات. استُخدم نفس adapter ونفس SQL بعد حقن أسماء جداول الاختبار، دون استبدال SQL بـMock. ports المصادقة وOnboarding وهمية بالكامل؛ لا HTTP إلى REIS.

امتلأ C: أثناء التجهيز الأول، وتوقف Docker ولم تكتمل تهيئة مستخدم الاختبار. بعد تحرير المستخدم مساحة محلية، أُعيد إنشاء الحاوية المخصصة فقط. أول فشل تهيئة لا يُحتسب نجاحًا؛ النتائج النهائية تُسجل أدناه. فشل اختبار حماية trigger أولًا لأن حارس SQL binds عدّ :OLD/:NEW كمتغيرات؛ أصلحنا fixture DDL المباشر على الاتصال المعزول، دون إضعاف حارس DML.

مرجع التحقق من سلوك المعاملات: [node-oracledb](https://node-oracledb.readthedocs.io/en/v6.4.0/user_guide/txn_management.html)، و[SQLite IMMEDIATE transactions](https://www.sqlite.org/lang_transaction.html). التطبيق يستخدم commit/rollback صريحين لاتصال Oracle المشترك، ولا يفترض معاملة موزعة مع SQLite.

## أمر Preflight للقراءة فقط

بعد بناء محلي بـ`npm run build`:

```powershell
node dist/tools/resume-preflight.js --evidence C:/protected/kyc-resume-export.json --sqlite C:/protected/kyc-local-copy.sqlite --report C:/protected/new-resume-preflight.json
```

هذا أمر OFFLINE على ملفات محلية، لا يستخرج بيانات من UAT1 ولا يدّعي مطابقة المصدر الحي. ملف report يجب ألا يكون موجودًا. ملخص stdout يعرض أسماء البوابات ونتائجها وبصمة الخطة فقط؛ التفاصيل الكاملة في report المحمي. `--help` يشرح الوسائط؛ أي وسيط تنفيذ مرفوض قبل فتح الملفات. لا يوجد أمر Apply جديد.

ملف `--evidence` مطابق لـ`ResumePreflightEvidence` في المصدر:

- `capturedAt` و`oracleSnapshotReference`: توقيت ومرجع export معتمد؛ صلاحية export المقترحة 15 دقيقة.
- `oracle`: MOD_NO وtrigger وopen/higherRevisionExists وstage الكامل بالأعمدة المحددة في read؛ REQUEST/RESPONSE كاملان، والتواريخ بصيغة `YYYY-MM-DD HH24:MI:SS` أو null.
- `oracleReceipt`: export للإيصال الدائم إن وُجد؛ null صريح فقط إذا أثبت SELECT عدم وجوده. وجوده يمنع خطة جديدة حتى لو فُقدت SQLite.
- `payload`: الناتج المحول الذي سيُراجع؛ لا CIF افتراضي ولا بيانات عميل مصطنعة في العمل الحقيقي.
- `history`: محاولتان بمعرفيهما الفعليين، `evidence` كمحتوى ملفات الأدلة الأصلية محفوظًا دون فقد (مثل bytes بbase64 وأسماء الملفات)، و`evidenceSha256=trialHash(evidence)`. ليست أوصافًا مختصرة مفترضة.
- `confirmation`: وثيقة REIS المؤرخة ومرجعها وهوية مؤكدها وبصمتها ونطاقها CIF/KYC/SEQ وبصمات المحاولتين، والنفي الصريح لكل من الإنشاء والمعالجة. صلاحية مقترحة ساعة؛ لا يولد الأمر تأكيدًا أو موافقة.

تُقرأ local cases وجميع callback audit والحجز من **نسخة SQLite ذاتها**، لا من ملخص يدوي. تبقى بوابات الموافقة المستقلة، والمراجعة الحية تحت الأقفال وSTOP، ومراجعة مصدر Finexta/SQL/عقد المستهلك ظاهرة كمطلوبة دائمًا. `sendingAuthorized=false` حتى لو اجتازت كل البوابات المحلية.

## النشر المقترح — لم يُنفذ

1. مراجعة diff ونتائج الاختبارات واعتماد إصدار كود/SQL محدد. مراجعة Finexta لتعريفات الجداول الفعلية والفهارس والقيود والصلاحيات والأقفال وترتيبها وW وtrigger E→P، وتأكيد أن SEQ_NO=MOD_NO=1 وعقد CLEAN/PENDING/BLOCKED ما زالا صحيحين. اختبار fixture لا يثبت ذلك.
2. إبقاء STOP وpolling والمرسلين معطلين كما هم، وتجميد التعديل على هوية الحالة خلال نافذة التنفيذ المتفق عليها؛ أقفال صف CUSTOMER لا تفرض بروتوكولًا على أنظمة خارجية لا تحترم القفل/العقد نفسه.
3. نسخ محمية موثقة من SQLite مع WAL/SHM إن وُجدا، وملفات المحاولتين الأصلية، وstaging/trigger/local case/callbacks وإيصالات Oracle. التحقق من قابلية الاسترجاع وبصمات النسخ وACL قبل أي نشر.
4. تطبيق migration المحلية `1790000000006-ResumeJournal` **بموافقة نشر مستقلة لاحقة فقط**. لا migrationsRun ولا schema synchronization تلقائيين. DDL إيصال Oracle وحمايته مقدمان كمولدات SQL في adapter للمراجعة، ولا ينفذهما مسار التطبيق أو Preflight؛ يلزم اعتماد مالك قاعدة البنك وصلاحيات لا تسمح حذف الإيصالات/تعطيل الحماية.
5. نشر حجر Callback أولًا قبل أي تمكين مستقبلي للاستكمال، مع تدقيق مستمر. لا إعادة فتح CIF callback تلقائيًا. الحصول على وثيقة REIS للمحاولتين وexport حديث وتقرير Preflight وموافقة جديدة باسم المراجع مرتبطة ببصمة الخطة. لا يُعاد استخدام موافقات قديمة.
6. ربط ports التنفيذ مستقبلًا بالمصدر وSTOP/منع polling/تجميد المرسلين وعميل HTTP بلا retries فقط بعد مراجعة مستقلة إضافية. **هذا الربط وأي أمر تشغيل حي متروكان عمدًا خارج هذا التسليم وفق طلب المستخدم.** لا تسجيل توكن ولا auth body.
7. عند تنفيذ حي معتمد مستقبلًا: محاولة واحدة فقط، حفظ wire، تحقق S/القرار/P على الصف نفسه وتحديث projection المحلي. PENDING يبقى قيد حجر callbacks إلى أن توجد مصالحة موثوقة؛ لا ترقية إلى CLEAN لأجل فتح الحساب.

## التراجع المقترح — لم يُنفذ

- أوقف أي orchestration جديد واترك STOP وpolling كما هما. لا تمسح الحجز أو history أو receipt، حتى إن لم تُرسل محاولة أو ظهر auth failure.
- لا تستخدم migration down لسجل Resume؛ ترفضه الشفرة حفاظًا على الأدلة. يمكن إبقاء الجداول الإضافية مع إصدار توافق لا ينفذ Resume، مع بقاء حجر Callback فعالًا. التراجع إلى كود يعيد تطبيق callback على آخر case دون هذه الحماية غير آمن لهذه الهوية.
- لا تعكس Oracle/SQLite إلى snapshot قديم مستقلًا عن الآخر، ولا تسترجع E→N/E→U، ولا تصفر retry_count. احتفظ بالنسخ والأصل الحالي كاملين، وافحص receipt وjournal لتحديد نقطة الالتزام.
- إن وُجد wire صالح: استكمال writeback الداخلي فقط مع CAS على المراجعة نفسها. إن لم يوجد: مصالحة مع REIS، دون إعادة إرسال. عند تغير MOD_NO لا تنقل القرار إلى نسخة جديدة.
- لا حذف للجداول أو guards بعد نشرها على البنك، ولا DROP/DELETE للإيصال. أي تسوية يدوية تتطلب تغييرًا مستقلًا موثقًا مع مالك البيانات، وليس خيار rollback تلقائيًا.

## ما بقي قبل أي جاهزية حية

ملفات الأدلة الفعلية للمحاولتين ووثيقة REIS لم تُقدم لهذا التنفيذ، فلم تُستورد أو تُعدل سجلات العميل الحقيقية. يلزم اعتماد DDL/صلاحيات/قيود وإصدار Oracle البنك، ونشر migration وreceipt guard على بيئة مصرح بها، والتحقق من STOP/توقف جميع المرسلين، واعتماد مصدر payload وعقد المستهلك، وموافقة مستقلة جديدة. لا يمكن حل هوية Callback من seqNo أو attemptId يضيفهما المرسل غير الموثوق؛ الحجر مستمر حتى اتفاق correlation موثوق أو مصالحة تشغيلية.

الاستكمال يفضل المنع والمصالحة على إعادة المحاولة بعد الشك. تجارب الانقطاع تحقن أخطاء وتغلق/تفتح SQLite وتعيد إنشاء المنسق؛ لا تدعي اختبار قطع كهرباء جهاز حقيقي أو فشل تخزين مادي. اختبارات الحجز تشمل اتصالات/عمال SQLite متزامنة وطلبات Oracle على اتصالات منفصلة.

## نتائج التحقق النهائية

الفحص الشامل النهائي: **1301 ناجحًا، 16 متجاوزًا، صفر فشل**؛ **63 مجموعة ناجحة و3 مجموعات متجاوزة**، المجموع 1317 اختبارًا و66 مجموعة. شُغلت اختبارات Resume مع Oracle المعزول مفعلة، وبقية تأكيدات Oracle القديمة معطلة في عملية الاختبار فقط.

- مجموعة `test/resume-oracle.integration.spec.ts`: **31 اختبارًا نُفذت فعليًا ونجحت على Oracle الحقيقي**، بما فيها المنسق وSQLite على القرص، الحجز المتزامن، فقد ACK للـcommit، drift، أخطاء قيود Oracle، CLOB يتجاوز 64KB، guard الأصلي، writeback والاستكمال بعد إعادة فتح SQLite، auth/STOP/تغير المصدر/MOD_NO/expiry، فقد الرد وفشل حفظه، وحجر callback المتأخر والمكرر والمتعارض. REIS ports وهمية ولم يُرسل HTTP إلى REIS.
- المجموعة القديمة `test/oracle-staging.sql.integration.spec.ts` و`test/single-kyc-trial.oracle.spec.ts` و`test/status-update.oracle.spec.ts`: **16 متجاوزًا**؛ لا يُنسب لها نجاح Oracle حقيقي في هذه الجولة. الفحوص الجديدة لا تستخدم Mock لـOracle adapter.
- `npm run lint` و`npx tsc --noEmit` و`npm run build`: ناجحة.
- `test/resume-journal.spec.ts`: اختبار عاملين منفصلين على SQLite حقيقي يثبت فائزًا واحدًا، واختبارات rollback/الاحتفاظ بالحجز/الحماية/كشف فساد الأدلة. اختبارات Preflight تستخدم readonly حقيقيًا وتتحقق من عدم تغير bytes قاعدة البيانات.
- اختبار mutation قلب شرط callback في dispatchIntent عمدًا: فشل اختبار الرجوع المطلوب كما ينبغي، ثم استُعيد المصدر الصحيح قبل الجولة الشاملة النهائية. الفشل المتعمد ليس فشلًا في النسخة النهائية.
- CLI المبني: `--help` ناجح؛ `--apply` مرفوض بخروج 1 قبل أي إجراء. لم يُشغل Preflight على أدلة العميل الحقيقية لعدم توفر export/نسخة SQLite/وثيقة REIS هنا.
- ظهرت ثلاثة إخفاقات في الجولة الشاملة الأولى: توقعا جداول قديمان، وmatcher لخطأ SQLite أصلي عبر سياق Jest. عُدلت اختبارات المخطط لتشمل الجداول الجديدة وتثبت منع rollback للسجل، وفحص خطأ SQLite يؤكد message وSQLITE_CONSTRAINT_TRIGGER. اجتازت النسخة النهائية الفحص كاملًا.

لم تُعدل `.env` أو STOP ولم يُفعل polling؛ بصمة `.env` بقيت مطابقة لبداية العمل. لا اتصال UAT1/Production أو REIS حقيقي ولا commit/push/نشر. فشل رأي Claude المستقل بسبب حد الجلسة؛ لا تُنسب مراجعة مستقلة ناجحة إليه.

## قائمة الملفات في شجرة العمل

يتضمن التسليم تحضير الجولة السابقة غير الملتزم، المحفوظ دون إزالته:

| المجموعة | الملفات |
|---|---|
| Resume | `src/resume/resume-journal.ts`، `src/resume/resume-oracle.adapter.ts`، `src/resume/resume-coordinator.ts` |
| التخزين والمعاملات | `src/persistence/migrations/1790000000006-ResumeJournal.ts`، `src/persistence/database.config.ts`، `src/flexcube/staging/oracle-sql-executor.ts` |
| الحجر | `src/kyc/single-kyc-trial.scope.ts`، `src/kyc/single-kyc-trial.gates.spec.ts` |
| Preflight والسياسة | `src/tools/resume-preflight.ts`، `src/tools/single-kyc-resume.plan.ts` |
| اختبارات جديدة | `test/resume-journal.spec.ts`، `test/resume-oracle.integration.spec.ts`، `test/resume-preflight.spec.ts`، `test/single-kyc-resume.plan.spec.ts` |
| اختبارات التكامل والمخطط المعدلة | `src/persistence/database.config.spec.ts`، `test/reference-mappings.integration.spec.ts`، `test/callback-revision-binding.integration.spec.ts`، `test/single-kyc-trial.integration.spec.ts` |
| تصحيح تشخيص التجربة السابق | `src/tools/single-kyc-trial.ts` |
| الوثائق | `docs/kyc-resume-implementation.md`، `docs/single-kyc-resume-review.md`، `docs/single-kyc-trial-runbook.md` |

سجلات التحقق المحلية في `outputs/resume-full-test.log` و`outputs/resume-oracle-test.log` و`outputs/resume-mutation-test.log` مستثناة من git. سجل الجولة المنفصلة لـOracle أقدم من الفحص الشامل النهائي؛ لا تجمع أعداده مع أعداد الجولة الشاملة.
