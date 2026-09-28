// Adversarial: named/optional params, closure params, nested defaults.
class Svc {
  int namedParams(int a, {int b = 2, int Function(int)? cb}) {
    return a + b;
  }
  int nestedDefault(int a, [int b = 2]) {
    return a + b;
  }
  String stringDelims({String sep = ")"}) {
    return sep;
  }
}
