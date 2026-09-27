// Adversarial: nested defaults, generics, closure params.
class Svc {
  def nestedDefault(a: Int = g(1, 2), b: Map[String, List[Int]]): Int = {
    a
  }
  def closureParam(cb: Int => Int, n: Int): Int = {
    cb(n)
  }
  def stringDelims(sep: String = ")"): String = {
    sep
  }
}

// #738: a body-less case class must not swallow the next class's body.
case class Dto(id: String)

class Consumer(dto: Dto) {
  def consume(n: Int): String = {
    dto.id
  }
}
